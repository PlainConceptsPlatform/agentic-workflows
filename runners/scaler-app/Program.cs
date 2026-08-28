// Runner scaler: the GitHub->Azure bridge for the agents-arc VMSS fleet.
//
// Cost-first policy, fixed by design:
//   demand 0      -> 0 VMs
//   demand 1..4   -> at most 1 VM
//   demand 5+     -> at most 2 VMs
//   MAX_VMS = 2 is a hard ceiling enforced at every write and re-checked after.
// Demand is queued+in_progress workflow jobs labeled agents-arc on private repos,
// learned from an org webhook. Jobs beyond capacity wait in GitHub on purpose.
//
// Each VM hosts exactly one ephemeral JIT runner, runs exactly one job, then asks
// to be deleted (/vm/done). The app then re-evaluates and boots the next VM if
// work remains. Nothing here ever places two jobs on one VM.

using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

var builder = WebApplication.CreateBuilder(args);
var port = Environment.GetEnvironmentVariable("PORT");
if (!string.IsNullOrEmpty(port)) builder.WebHost.UseUrls($"http://*:{port}");
var app = builder.Build();
var log = app.Logger;

string Req(string name) => Environment.GetEnvironmentVariable(name)
    ?? throw new InvalidOperationException($"missing app setting {name}");

var ghPat         = Req("GH_PAT");
var ghOrg         = Req("GH_ORG");
var webhookSecret = Req("WEBHOOK_SECRET");
var vmToken       = Req("VM_TOKEN");
var subscription  = Req("AZ_SUBSCRIPTION");
var resourceGroup = Req("AZ_RG");
var vmssName      = Req("AZ_VMSS");
var runnerLabel   = Environment.GetEnvironmentVariable("RUNNER_LABEL") ?? "agents-arc";
var runnerGroupId = int.Parse(Environment.GetEnvironmentVariable("RUNNER_GROUP_ID") ?? "6");

// The one number a bug must never exceed. Post-write verification scales back down.
const int MaxVms = 2;

var vmssUrl = $"https://management.azure.com/subscriptions/{subscription}/resourceGroups/{resourceGroup}" +
              $"/providers/Microsoft.Compute/virtualMachineScaleSets/{vmssName}";
const string ArmApi = "2024-07-01";

var http = new HttpClient();
http.DefaultRequestHeaders.UserAgent.ParseAdd("agentrunner-scaler/1.0");

var dataDir = Path.Combine(Environment.GetEnvironmentVariable("HOME") ?? ".", "data");
Directory.CreateDirectory(dataDir);
var ledgerPath = Path.Combine(dataDir, "ledger.json");

// job id -> (status, last update). queued and in_progress entries both count as demand.
var ledger = new ConcurrentDictionary<long, JobEntry>();
try
{
    if (File.Exists(ledgerPath))
        foreach (var kv in JsonSerializer.Deserialize<Dictionary<long, JobEntry>>(File.ReadAllText(ledgerPath)) ?? [])
            ledger[kv.Key] = kv.Value;
}
catch (Exception e) { log.LogWarning("ledger load failed: {m}", e.Message); }

var ledgerLock = new object();
void SaveLedger()
{
    lock (ledgerLock)
        File.WriteAllText(ledgerPath, JsonSerializer.Serialize(ledger.ToDictionary(k => k.Key, v => v.Value)));
}

// Ghost-demand self-healing: if VMs keep coming up and GitHub hands them nothing,
// the queued entries are leftovers from missed webhooks. Three fruitless VM cycles
// with no job activity clears them, instead of paying for boot loops forever.
var fruitlessCycles = 0;
var lastJobActivity = DateTimeOffset.UtcNow;

// ---- Azure (managed identity, no SDK) ----
string? armToken = null;
DateTimeOffset armTokenExpiry = DateTimeOffset.MinValue;
var tokenLock = new SemaphoreSlim(1, 1);
async Task<string> ArmToken()
{
    if (armToken is not null && DateTimeOffset.UtcNow < armTokenExpiry) return armToken;
    await tokenLock.WaitAsync();
    try
    {
        if (armToken is not null && DateTimeOffset.UtcNow < armTokenExpiry) return armToken;
        var ep = Req("IDENTITY_ENDPOINT");
        var hdr = Req("IDENTITY_HEADER");
        using var req = new HttpRequestMessage(HttpMethod.Get,
            $"{ep}?resource=https://management.azure.com/&api-version=2019-08-01");
        req.Headers.Add("X-IDENTITY-HEADER", hdr);
        var resp = await http.SendAsync(req);
        resp.EnsureSuccessStatusCode();
        var node = JsonNode.Parse(await resp.Content.ReadAsStringAsync())!;
        armToken = node["access_token"]!.GetValue<string>();
        var expiresOn = node["expires_on"]!.GetValue<string>();
        armTokenExpiry = DateTimeOffset.FromUnixTimeSeconds(long.Parse(expiresOn)).AddMinutes(-5);
        return armToken;
    }
    finally { tokenLock.Release(); }
}

async Task<HttpResponseMessage> Arm(HttpMethod method, string url, object? body = null)
{
    using var req = new HttpRequestMessage(method, url);
    req.Headers.Authorization = new("Bearer", await ArmToken());
    if (body is not null)
        req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
    return await http.SendAsync(req);
}

async Task<int> Capacity()
{
    var resp = await Arm(HttpMethod.Get, $"{vmssUrl}?api-version={ArmApi}");
    resp.EnsureSuccessStatusCode();
    return JsonNode.Parse(await resp.Content.ReadAsStringAsync())!["sku"]!["capacity"]!.GetValue<int>();
}

async Task<List<(string Id, string State)>> Instances()
{
    var resp = await Arm(HttpMethod.Get, $"{vmssUrl}/virtualMachines?api-version={ArmApi}");
    resp.EnsureSuccessStatusCode();
    var node = JsonNode.Parse(await resp.Content.ReadAsStringAsync())!;
    return (node["value"] as JsonArray ?? [])
        .Select(v => (v!["instanceId"]!.GetValue<string>(),
                      v["properties"]?["provisioningState"]?.GetValue<string>() ?? "Unknown"))
        .ToList();
}

async Task SetCapacity(int target)
{
    target = Math.Min(target, MaxVms);
    var resp = await Arm(HttpMethod.Patch, $"{vmssUrl}?api-version={ArmApi}",
        new { sku = new { capacity = target } });
    if (!resp.IsSuccessStatusCode)
        log.LogError("capacity patch to {t} failed: {s} {b}", target, resp.StatusCode, await resp.Content.ReadAsStringAsync());
}

async Task DeleteInstance(string id)
{
    var resp = await Arm(HttpMethod.Post, $"{vmssUrl}/delete?forceDeletion=true&api-version={ArmApi}",
        new { instanceIds = new[] { id } });
    if (!resp.IsSuccessStatusCode)
        log.LogError("delete instance {id} failed: {s} {b}", id, resp.StatusCode, await resp.Content.ReadAsStringAsync());
}

// ---- GitHub ----
async Task<string?> MintJit(string name)
{
    using var req = new HttpRequestMessage(HttpMethod.Post,
        $"https://api.github.com/orgs/{ghOrg}/actions/runners/generate-jitconfig");
    req.Headers.Authorization = new("Bearer", ghPat);
    req.Headers.Accept.ParseAdd("application/vnd.github+json");
    req.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
    req.Content = new StringContent(JsonSerializer.Serialize(new
    {
        name,
        runner_group_id = runnerGroupId,
        labels = new[] { runnerLabel },
        work_folder = "_work",
    }), Encoding.UTF8, "application/json");
    var resp = await http.SendAsync(req);
    if (!resp.IsSuccessStatusCode)
    {
        log.LogError("jit mint failed: {s} {b}", resp.StatusCode, await resp.Content.ReadAsStringAsync());
        return null;
    }
    return JsonNode.Parse(await resp.Content.ReadAsStringAsync())!["encoded_jit_config"]!.GetValue<string>();
}

// ---- policy ----
int Demand() => ledger.Count;
int DesiredVms(int demand) => demand switch { <= 0 => 0, <= 4 => 1, _ => 2 };

var evalLock = new SemaphoreSlim(1, 1);
async Task Evaluate(string reason)
{
    await evalLock.WaitAsync();
    try
    {
        var demand = Demand();
        var desired = Math.Min(DesiredVms(demand), MaxVms);
        var instances = await Instances();
        var active = instances.Count(i => i.State is not "Deleting" and not "Failed");
        log.LogInformation("evaluate({r}): demand={d} desired={want} active={a} states=[{s}]",
            reason, demand, desired, active,
            string.Join(",", instances.Select(i => $"{i.Id}:{i.State}")));

        foreach (var failed in instances.Where(i => i.State == "Failed"))
        {
            log.LogWarning("deleting failed instance {id}", failed.Id);
            await DeleteInstance(failed.Id);
        }

        if (active < desired)
            await SetCapacity(Math.Min(active + (desired - active), MaxVms));

        // hard-cap watchdog: whatever went wrong above or elsewhere, never allow >2
        var cap = await Capacity();
        if (cap > MaxVms)
        {
            log.LogError("capacity {c} exceeds MAX_VMS={m}; forcing back down", cap, MaxVms);
            await SetCapacity(MaxVms);
        }
    }
    catch (Exception e) { log.LogError("evaluate failed: {m}", e.Message); }
    finally { evalLock.Release(); }
}

// ---- auth helpers ----
bool VmAuthorized(HttpRequest r) =>
    r.Headers.Authorization.ToString() is var h && h.StartsWith("Bearer ") &&
    CryptographicOperations.FixedTimeEquals(
        Encoding.UTF8.GetBytes(h["Bearer ".Length..]), Encoding.UTF8.GetBytes(vmToken));

bool SignatureValid(string body, string? header)
{
    if (header is null || !header.StartsWith("sha256=")) return false;
    var expected = Convert.ToHexString(
        HMACSHA256.HashData(Encoding.UTF8.GetBytes(webhookSecret), Encoding.UTF8.GetBytes(body)));
    return CryptographicOperations.FixedTimeEquals(
        Encoding.UTF8.GetBytes(header["sha256=".Length..].ToLowerInvariant()),
        Encoding.UTF8.GetBytes(expected.ToLowerInvariant()));
}

// ---- endpoints ----
app.MapGet("/healthz", () => "ok");

app.MapGet("/status", async (HttpRequest r) =>
{
    if (!VmAuthorized(r)) return Results.Unauthorized();
    var instances = await Instances();
    return Results.Json(new
    {
        demand = Demand(),
        desired = DesiredVms(Demand()),
        maxVms = MaxVms,
        capacity = await Capacity(),
        instances = instances.Select(i => new { i.Id, i.State }),
        jobs = ledger.Select(kv => new { id = kv.Key, kv.Value.Status, kv.Value.UpdatedUtc }),
        fruitlessCycles,
    });
});

app.MapPost("/github", async (HttpRequest r) =>
{
    string body;
    using (var sr = new StreamReader(r.Body)) body = await sr.ReadToEndAsync();
    if (!SignatureValid(body, r.Headers["X-Hub-Signature-256"]))
        return Results.Unauthorized();
    if (r.Headers["X-GitHub-Event"] != "workflow_job") return Results.Ok("ignored event");

    var node = JsonNode.Parse(body)!;
    var job = node["workflow_job"]!;
    var labels = (job["labels"] as JsonArray ?? []).Select(l => l!.GetValue<string>());
    var isPrivate = node["repository"]?["private"]?.GetValue<bool>() ?? false;
    if (!labels.Contains(runnerLabel) || !isPrivate) return Results.Ok("not ours");

    var id = job["id"]!.GetValue<long>();
    var action = node["action"]!.GetValue<string>();
    switch (action)
    {
        case "queued":
            ledger[id] = new("queued", DateTimeOffset.UtcNow);
            break;
        case "in_progress":
            ledger[id] = new("in_progress", DateTimeOffset.UtcNow);
            fruitlessCycles = 0;
            lastJobActivity = DateTimeOffset.UtcNow;
            break;
        case "completed":
            ledger.TryRemove(id, out _);
            lastJobActivity = DateTimeOffset.UtcNow;
            break;
    }
    SaveLedger();
    log.LogInformation("webhook: job {id} {a}; demand now {d}", id, action, Demand());
    _ = Task.Run(() => Evaluate($"webhook:{action}"));
    return Results.Ok("ok");
});

app.MapPost("/vm/jit", async (HttpRequest r) =>
{
    if (!VmAuthorized(r)) return Results.Unauthorized();
    var node = JsonNode.Parse(await new StreamReader(r.Body).ReadToEndAsync())!;
    var instanceId = node["instanceId"]!.GetValue<string>();
    var known = (await Instances()).Any(i => i.Id == instanceId);
    if (!known) { log.LogWarning("jit request from unknown instance {id}", instanceId); return Results.Unauthorized(); }
    if (Demand() <= 0) { log.LogInformation("instance {id} asked for work; none queued", instanceId); return Results.NoContent(); }
    var jit = await MintJit($"i{instanceId}-{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}");
    if (jit is null) return Results.StatusCode(502);
    log.LogInformation("jit issued to instance {id}", instanceId);
    return Results.Text(jit);
});

app.MapPost("/vm/done", async (HttpRequest r) =>
{
    if (!VmAuthorized(r)) return Results.Unauthorized();
    var node = JsonNode.Parse(await new StreamReader(r.Body).ReadToEndAsync())!;
    var instanceId = node["instanceId"]!.GetValue<string>();
    var gotJob = node["ranJob"]?.GetValue<bool>() ?? false;
    log.LogInformation("instance {id} done (ranJob={j}); deleting", instanceId, gotJob);
    if (!gotJob)
    {
        fruitlessCycles++;
        if (fruitlessCycles >= 3 && DateTimeOffset.UtcNow - lastJobActivity > TimeSpan.FromMinutes(30))
        {
            log.LogWarning("{n} fruitless VM cycles with no job activity; clearing stale queued ledger", fruitlessCycles);
            foreach (var kv in ledger.Where(kv => kv.Value.Status == "queued").ToList())
                ledger.TryRemove(kv.Key, out _);
            SaveLedger();
            fruitlessCycles = 0;
        }
    }
    await DeleteInstance(instanceId);
    _ = Task.Run(async () => { await Task.Delay(TimeSpan.FromSeconds(30)); await Evaluate("vm-done"); });
    return Results.Ok("bye");
});

// reconcile sweep: prune forgotten ledger entries, clean failed instances, re-evaluate
_ = Task.Run(async () =>
{
    while (true)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(5));
            var changed = false;
            foreach (var kv in ledger.ToList())
            {
                var age = DateTimeOffset.UtcNow - kv.Value.UpdatedUtc;
                var stale = kv.Value.Status == "in_progress" ? age > TimeSpan.FromHours(8)
                                                             : age > TimeSpan.FromHours(24);
                if (stale) { ledger.TryRemove(kv.Key, out _); changed = true; log.LogWarning("pruned stale job {id}", kv.Key); }
            }
            if (changed) SaveLedger();
            await Evaluate("timer");
        }
        catch (Exception e) { log.LogError("reconcile loop: {m}", e.Message); }
    }
});

app.Run();

record JobEntry(string Status, DateTimeOffset UpdatedUtc);
