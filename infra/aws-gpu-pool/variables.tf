variable "region" {
  description = "AWS region for the GPU pool. Pick one where your account has GPU instance quota."
  type        = string
  default     = "ap-south-1"
}

variable "name" {
  description = "Name prefix for every resource in this module."
  type        = string
  default     = "gpu-pool"
}

variable "ami_id" {
  description = "AMI with the NVIDIA driver preinstalled (for example an AWS Deep Learning AMI). Required, because this module does not look one up."
  type        = string
}

variable "subnet_ids" {
  description = "Subnets for the Auto Scaling group. Use private subnets."
  type        = list(string)
}

variable "instance_type" {
  description = "GPU instance type. g4dn.xlarge has one 16 GB T4 GPU and is the cheapest common option."
  type        = string
  default     = "g4dn.xlarge"
}

variable "max_size" {
  description = "Hard ceiling on instances. Capped at 2 so a bad change cannot run up a bill."
  type        = number
  default     = 1

  validation {
    condition     = var.max_size >= 0 && var.max_size <= 2
    error_message = "max_size must be between 0 and 2 for this module."
  }
}

variable "desired_when_on" {
  description = "Instances to run during working hours. Use 0 to keep the pool off until you need it."
  type        = number
  default     = 0

  validation {
    condition     = var.desired_when_on >= 0 && var.desired_when_on <= 2
    error_message = "desired_when_on must be between 0 and 2."
  }
}

variable "scale_up_cron" {
  description = "When to start the pool, in UTC cron format. Empty string disables the scale-up schedule."
  type        = string
  default     = ""
}

variable "scale_down_cron" {
  description = "When to stop the pool, in UTC cron format. Scale-to-zero is the main cost control."
  type        = string
  default     = "30 16 * * *" # 22:00 IST
}

variable "monthly_budget_usd" {
  description = "Monthly cost limit in USD. Alerts are sent at 50%, 80% and 100% (forecast)."
  type        = number
  default     = 5
}

variable "alert_email" {
  description = "Email address for budget alerts."
  type        = string
}

variable "tags" {
  description = "Tags added to every resource."
  type        = map(string)
  default     = {}
}
