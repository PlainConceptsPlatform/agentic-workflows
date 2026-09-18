// Packer template to build a pre-baked runner image into the Azure Compute Gallery.
//
// All dependencies that cloud-init used to install at boot are baked in here:
// docker-ce, gh, az, trivy, the actions runner binary, ripgrep, RTK, agentmemory,
// codegraph, openspec, .NET SDK, and the Docker Compose plugin.
//
// Build:
//   cd runners && packer init build-image.pkr.hcl
//   packer build -var-file=packer-variables.pkrvars.hcl build-image.pkr.hcl
//
// Or via CI: .github/workflows/build-runner-image.yml
//
// The resulting image is generalized (Packer handles this), so cloud-init
// only needs to create swap, drop the VM token, and start the service.
//
// Required variables are in the variables block below; provide them via
// -var-file or environment variables (PACKER_VAR_).

packer {
  required_plugins {
    azure = {
      version   = ">= 2.2.0"
      source    = "github.com/hashicorp/azure"
    }
  }
}

variable "subscription_id" {
  default = "00000000-0000-0000-0000-000000000000"
  type        = string
  sensitive   = true
  description = "Azure subscription ID (used in CI)"
}

variable "tenant_id" {
  default = "00000000-0000-0000-0000-000000000000"
  type        = string
  sensitive   = true
  description = "Azure tenant ID"
}

variable "client_id" {
  default = "00000000-0000-0000-0000-000000000000"
  type        = string
  sensitive   = true
  description = "Azure service principal client ID"
}

variable "client_secret" {
  type        = string
  sensitive   = true
  description = "Azure service principal client secret"
  default = "dummy"
}

variable "resource_group" {
  type = string
  default = "agentrunner-pro-rg-01"
  description = "Resource group for the build"
}

variable "gallery_name" {
  type = string
  default = "agentrunner-gallery-01"
  description = "Gallery name for the resulting image"
}

variable "image_definition" {
  type = string
  default = "agents-arc-runner"
  description = "Image name to publish"
}

variable "location" {
  type = string
  default = "westeurope"
  description = "Azure region for the gallery"
}

variable "vm_size" {
  type = string
  default = "Standard_D4ads_v5"
  description = "Size of the VM used to build"
}

variable "image_version" {
  type        = string
  default     = "1.0.0"
  description = "Semver for the gallery image version"
}

variable "runner_version" {
  type        = string
  default     = "2.337.0"
  description = "Version of the actions runner binary (pinned to golden image)"
}

source "azure-arm" "runner-image" {
  client_id          = var.client_id
  client_secret      = var.client_secret
  tenant_id          = var.tenant_id
  subscription_id    = var.subscription_id

  build_resource_group_name = var.resource_group
  vm_size                  = var.vm_size

  image_offer     = "ubuntu-24_04-lts"
  image_publisher = "Canonical"
  image_sku       = "server"
  image_version   = "latest"

  # os_disk_size_gb = 30 — must stay at or below the VMSS diskSizeGB of 64
  # smaller = less copied to local NVMe at VM create.
  os_type           = "Linux"
  os_disk_size_gb   = 30

  shared_image_gallery_destination {
    resource_group       = var.resource_group
    gallery_name         = var.gallery_name
    image_name           = var.image_definition
    image_version        = var.image_version
    replication_regions  = [var.location]
    storage_account_type = "Premium_LRS"
  }
}

build {
  sources = ["source.azure-arm.runner-image"]

  # Single source of truth for pinned tool versions, uploaded and sourced by the
  # provision script so the image never resolves "latest" at build time.
provisioner "file" {
    source      = "./versions.env"
    destination = "/tmp/versions.env"
}

  provisioner "shell" {
    script          = "provision-image.sh"
    execute_command = "sudo bash '{{ .Path }}'"
  }

  # IMG-05: explicit generalization. Packer runs `waagent -deprovision+user`, but
  # cloud-init state must ALSO be cleaned or cloud-init on new VMs believes it
  # already ran, skips config/final, and the fleet boots fast and serves no jobs.
  provisioner "shell" {
    execute_command = "sudo bash '{{ .Path }}'"
    inline = [
      "cloud-init clean --logs --seed --machine-id",
      "rm -rf /var/lib/cloud",
      "truncate -s 0 /etc/machine-id",
      "rm -f /etc/ssh/ssh_host_*",
      "waagent -force -deprovision+user || true",
    ]
  }
}
