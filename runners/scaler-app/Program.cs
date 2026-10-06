// Runner scaler: the GitHub->Azure bridge for the agents-arc VMSS fleet.
//
// Cost-first policy, fixed by design:
//   demand 0      -> 0 VMs
//   demand 1..4   -> at most 1 VM
//   demand 5..8   -> at most 2 VMs
//   demand 9..12  -> at most 3 VMs
//   demand 13..16 -> at most 4 VMs
//   demand 17..20 -> at most 5 VMs
//   demand 21+    -> at most 6 VMs
//   MAX_VMS = 6 is a hard ceiling enforced at every write and re-checked after.
// Demand is queued+in_progress workflow jobs labeled agents-arc on private repos,
// learned from an org webhook. Jobs beyond capacity wait in GitHub on purpose.
//
// A VM runs one job at a time and asks for the next one itself (/vm/jit), resetting
// Docker state between jobs; it reports /vm/done and is deleted once the queue stays
// empty, so a boot is paid per burst rather than per job. Two jobs never run
// concurrently on one VM, and every JIT registration is single-use.

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
const int MaxVms = 6;

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
// Reuse telemetry, in-memory: jobs per retired VM. 1.0 means no reuse is happening.
var totalVmsRetired = 0;
var totalJobsServed = 0;

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
    else
        log.LogInformation("capacity patch -> {t}", target);
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

// Unregister any runner whose name starts with i{instanceId}- from the GitHub org.
// /vm/done calls DeleteInstance on the Azure side but without this the runner record
// stays on GitHub forever as "offline", inflating the org's runner list and confusing
// the zombie-checker's runnerNames comparison. Safe to be best-effort: if it fails the
// next reconcile sweep will just see one extra offline entry.
async Task DeleteGhostRunner(string instanceId)
{
    try
    {
        var prefix = $"i{instanceId}-";
        var url = $"https://api.github.com/orgs/{ghOrg}/actions/runners?per_page=100";
        while (url is not null)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Authorization = new("Bearer", ghPat);
            req.Headers.Accept.ParseAdd("application/vnd.github+json");
            req.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
            var resp = await http.SendAsync(req);
            if (!resp.IsSuccessStatusCode) { log.LogWarning("ghost runner cleanup: list failed {s}", resp.StatusCode); return; }
            var node = JsonNode.Parse(await resp.Content.ReadAsStringAsync())!;
            foreach (var r in node["runners"] as JsonArray ?? [])
            {
                var name = r?["name"]?.GetValue<string>();
                var id = r?["id"]?.GetValue<int>();
                if (name is not null && name.StartsWith(prefix) && id is int rid)
                {
                    using var del = new HttpRequestMessage(HttpMethod.Delete,
                        $"https://api.github.com/orgs/{ghOrg}/actions/runners/{rid}");
                    del.Headers.Authorization = new("Bearer", ghPat);
                    del.Headers.Accept.ParseAdd("application/vnd.github+json");
                    del.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
                    var delResp = await http.SendAsync(del);
                    log.LogInformation("ghost runner cleanup: {name} (id={id}) -> {s}", name, rid, delResp.StatusCode);
                }
            }
            // Same safe Link-header pagination as GitHubRunnerCount.
            IEnumerable<string>? linkHeaders = null;
            resp.Headers.TryGetValues("Link", out linkHeaders);
            var link = linkHeaders?.FirstOrDefault() ?? "";
            var match = System.Text.RegularExpressions.Regex.Match(link, "<([^>]+)>; rel=\"next\"");
            url = match.Success ? match.Groups[1].Value : null;
        }
    }
    catch (Exception e) { log.LogWarning("ghost runner cleanup error: {m}", e.Message); }
}

async Task<int> GitHubRunnerCount()
{
    try
    {
        var total = 0;
        var url = $"https://api.github.com/orgs/{ghOrg}/actions/runners?per_page=100";
        while (url is not null)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Authorization = new("Bearer", ghPat);
            req.Headers.Accept.ParseAdd("application/vnd.github+json");
            req.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
            var resp = await http.SendAsync(req);
            if (!resp.IsSuccessStatusCode) { log.LogWarning("runner count failed: {s}", resp.StatusCode); return -1; }
            var node = JsonNode.Parse(await resp.Content.ReadAsStringAsync())!;
            total += (node["runners"] as JsonArray ?? []).Count(r => r?["status"]?.GetValue<string>() == "online");
            // GitHub omits the Link header when there is a single page (≤100 runners).
            // GetValues throws on absent headers, which made the zombie-checker fall into
            // its catch and return -1 every 10 minutes — disabling zombie detection
            // entirely on small orgs. TryGetValues is the safe form.
            IEnumerable<string>? linkHeaders = null;
            resp.Headers.TryGetValues("Link", out linkHeaders);
            var link = linkHeaders?.FirstOrDefault() ?? "";
            var match = System.Text.RegularExpressions.Regex.Match(link, "<([^>]+)>; rel=\"next\"");
            url = match.Success ? match.Groups[1].Value : null;
        }
        return total;
    }
    catch (Exception e) { log.LogWarning("runner count error: {m}", e.Message); return -1; }
}

// ---- policy ----
int Demand() => ledger.Count;
int DesiredVms(int demand) => demand switch { <= 0 => 0, <= 4 => 1, <= 8 => 2, <= 12 => 3, <= 16 => 4, <= 20 => 5, _ => 6 };

var evalLock = new SemaphoreSlim(1, 1);
async Task Evaluate(string reason)
{
    await evalLock.WaitAsync();
    try
    {
        var demand = Demand();
        var desired = Math.Min(DesiredVms(demand), MaxVms);
        var instances = await Instances();
        // A VM counts as active capacity only when it can serve jobs: Creating/Updating
        // instances cannot accept JIT requests yet, so counting them inflates capacity
        // and hides the gap between "Azure says it exists" and "GitHub can hand it work".
        var active = instances.Count(i => i.State is not "Deleting" and not "Failed" and not "Creating" and not "Updating");
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
        else if (active > desired)
        {
            // Scale down by lowering VMSS capacity — but only when no job is in flight.
            // In Uniform orchestration Azure chooses which instance to delete when capacity
            // drops, and that choice is not aware of which VM is serving an in_progress job.
            // Killing the serving VM mid-run is the silent-never-fires failure this scaler
            // exists to prevent, so when jobs are in flight we trust /vm/done self-retirement
            // (cloud-init idle loop) to retire the surplus idle VM instead.
            var inProgress = ledger.Count(kv => kv.Value.Status == "in_progress");
            if (inProgress == 0)
            {
                log.LogInformation("scale-down: active={a} > desired={d} with no jobs in flight; capacity -> {d}", active, desired, desired);
                await SetCapacity(desired);
            }
            else
            {
                log.LogInformation("scale-down deferred: {n} job(s) in flight; waiting for /vm/done self-retirement", inProgress);
            }
        }

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
    // Azure state degrades to an error string so the GitHub side (ledger, demand)
    // stays visible while IAM is missing or ARM is down.
    object azure;
    try
    {
        var instances = await Instances();
        azure = new { capacity = await Capacity(), instances = instances.Select(i => new { i.Id, i.State }) };
    }
    catch (Exception e) { azure = new { error = e.Message }; }
    return Results.Json(new
    {
        demand = Demand(),
        desired = DesiredVms(Demand()),
        maxVms = MaxVms,
        azure,
        jobs = ledger.Select(kv => new { id = kv.Key, kv.Value.Status, kv.Value.UpdatedUtc }),
        fruitlessCycles,
        reuse = new
        {
            vmsRetired = totalVmsRetired,
            jobsServed = totalJobsServed,
            jobsPerVm = totalVmsRetired == 0 ? 0 : Math.Round((double)totalJobsServed / totalVmsRetired, 2),
        },
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
    // A VM is asking for work. Only hand out a JIT config when there is a job that is
    // actually waiting to be claimed — a job already "in_progress" already has a runner.
    // Counting in_progress here is the root cause of "2 VMs for 1 task": the second VM
    // sees demand=1 (the in_progress job), mints a JIT, registers as a runner nobody will
    // hire, and spins in job.sh minting a fresh JIT every few seconds until idle timeout.
    var queued = ledger.Count(kv => kv.Value.Status == "queued");
    if (queued <= 0) { log.LogInformation("instance {id} asked for work; none queued (in_progress jobs already have runners)", instanceId); return Results.NoContent(); }
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
    // jobsRun is how we measure reuse: 1 means the VM paid a full boot for a single job,
    // which is the waste the reuse loop exists to remove.
    var jobsRun = node["jobsRun"]?.GetValue<int>() ?? (gotJob ? 1 : 0);
    totalVmsRetired++;
    totalJobsServed += jobsRun;
    log.LogInformation(
        "instance {id} done: jobsRun={n} (lifetime avg {avg:F1} jobs/VM over {vms} VMs); deleting",
        instanceId, jobsRun, totalVmsRetired == 0 ? 0 : (double)totalJobsServed / totalVmsRetired, totalVmsRetired);
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
    _ = Task.Run(() => DeleteGhostRunner(instanceId));  // fire-and-forget: Azure delete already in flight
    _ = Task.Run(async () => { await Task.Delay(TimeSpan.FromSeconds(30)); await Evaluate("vm-done"); });
    return Results.Ok("bye");
});

// reconcile sweep: prune forgotten ledger entries, clean failed instances, kill zombie VMs,
// and re-evaluate. A zombie is a VM that is "Succeeded" in Azure but has no runner registered
// on GitHub job.sh crashed or the runner process died, and /vm/done was never called, so the
// scaler counts it as active capacity while nothing can serve jobs.
var lastZombieCheck = DateTimeOffset.UtcNow;
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

            // Zombie detection: if we have active VMs but no runner is registered on GitHub,
            // those VMs are dead. Delete them so the evaluate pass can boot fresh ones.
            // Check at most every 10 minutes to avoid burning API quota on every sweep.
            if (DateTimeOffset.UtcNow - lastZombieCheck > TimeSpan.FromMinutes(10))
            {
                lastZombieCheck = DateTimeOffset.UtcNow;
                var instances = await Instances();
                var active = instances.Where(i => i.State is not "Deleting" and not "Failed").ToList();
                if (active.Count > 0)
                {
                    var ghRunners = await GitHubRunnerCount();
                    if (ghRunners == 0)
                    {
                        // Guard: when VMs are legitimately between jobs (JIT is single-use —
                        // run.sh exits after each job, and the runner record is "offline"
                        // until job.sh mints the next JIT), we briefly have 0 online runners
                        // with active VMs. That is normal, not zombies. Only nuke after a
                        // sustained silence: no job activity for 5 minutes.
                        var sinceActivity = DateTimeOffset.UtcNow - lastJobActivity;
                        if (sinceActivity < TimeSpan.FromMinutes(5))
                        {
                            log.LogInformation("zombie detection: {n} VM(s) but 0 online runners; {s:F0}s since last job activity < 5min grace, skipping nuke",
                                active.Count, sinceActivity.TotalSeconds);
                        }
                        else
                        {
                            log.LogWarning("zombie detection: {n} active VM(s) but 0 runners on GitHub for {s:F0}s; deleting all instances",
                                active.Count, sinceActivity.TotalSeconds);
                            foreach (var inst in active)
                                await DeleteInstance(inst.Id);
                            fruitlessCycles = 0;
                            // Do NOT clear the queued ledger. Those entries came from real
                            // GitHub webhooks for jobs that are genuinely waiting. Deleting
                            // them here makes the scaler forget demand that still exists on
                            // GitHub, so the queued jobs sit unassigned until the next webhook.
                            // GitHub re-issues webhooks and a fresh VM will pick them up.
                        }
                    }
                    else
                    {
                        // Dead VMs may also show as "Succeeded" for days; check each instance's
                        // registration individually against GitHub's runner list.
                        var runnerNames = new HashSet<string>();
                        try
                        {
                            var url = $"https://api.github.com/orgs/{ghOrg}/actions/runners?per_page=100";
                            while (url is not null)
                            {
                                using var req = new HttpRequestMessage(HttpMethod.Get, url);
                                req.Headers.Authorization = new("Bearer", ghPat);
                                req.Headers.Accept.ParseAdd("application/vnd.github+json");
                                req.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
                                var resp = await http.SendAsync(req);
                                resp.EnsureSuccessStatusCode();
                                var node = JsonNode.Parse(await resp.Content.ReadAsStringAsync())!;
                                var count = (node["runners"] as JsonArray ?? []).Count;
                                foreach (var r in node["runners"] as JsonArray ?? [])
                                    if (r?["name"]?.GetValue<string>() is string n)
                                        runnerNames.Add(n);
                                // Same Link-header fix as GitHubRunnerCount: avoid throwing
                                // on the common single-page case.
                                IEnumerable<string>? linkHeaders = null;
                                resp.Headers.TryGetValues("Link", out linkHeaders);
                                var link = linkHeaders?.FirstOrDefault() ?? "";
                                var match = System.Text.RegularExpressions.Regex.Match(link, "<([^>]+)>; rel=\"next\"");
                                url = match.Success ? match.Groups[1].Value : null;
                            }
                        }
                        catch (Exception e) { log.LogWarning("runner name list error: {m}", e.Message); }

                        foreach (var inst in active)
                        {
                            // Runner names are "i{instanceId}-{timestamp}". Match by prefix.
                            var registered = runnerNames.Any(n => n.StartsWith($"i{inst.Id}-"));
                            if (!registered)
                            {
                                // Give freshly-booted VMs time to register before declaring them zombies.
                                // A VM that was just created by Evaluate() needs ~60s to boot + register.
                                log.LogInformation("instance {id} not yet registered on GitHub", inst.Id);
                            }
                        }
                    }
                }
            }

            await Evaluate("timer");
        }
        catch (Exception e) { log.LogError("reconcile loop: {m}", e.Message); }
    }
});

app.Run();

record JobEntry(string Status, DateTimeOffset UpdatedUtc);
