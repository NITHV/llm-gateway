# aws-gpu-pool

A Terraform module for a GPU node pool on AWS, built for a zero-budget setup:

- **Scale to zero.** The Auto Scaling group starts at 0 instances. A nightly schedule keeps it at 0, so an idle pool costs nothing.
- **Hard ceiling.** `max_size` is validated to be 2 or less. A bad change can't launch a large fleet.
- **Budget alerts.** A monthly AWS Budget emails at 50% and 80% of actual spend, and at 100% of forecast spend.
- **Secure nodes.** IMDSv2 is required, EBS volumes are encrypted, and the security group has no inbound rules.

## Status

- `terraform fmt -check` and `terraform validate` pass.
- **Not applied.** Applying creates real AWS resources, and this project has no budget for that. A `plan` needs AWS credentials, so it hasn't been run either. The variable checks run at plan time.

## Use it (once you have an AWS account and credentials)

```powershell
cd infra\aws-gpu-pool
copy terraform.tfvars.example terraform.tfvars   # then fill in the values
terraform init
terraform plan        # read this before every apply
terraform apply       # only when you intend to create resources
```

To run the pool for a session, set `desired_when_on` (or use the AWS CLI with `aws autoscaling set-desired-capacity`). Scale it back to 0 when you're done.

## SRE notes

- **Scale to zero versus warm capacity.** A warm pool gives fast starts but costs money all day. Scale-to-zero is cheap, but the first request waits for a boot and a model load. For a learning project, the cold start is an acceptable trade.
- **Budgets as an early warning.** A budget alert is a notification, not a limit. It tells you the spend is climbing. It doesn't stop the spending, which is why the ceiling and schedule are in the module as well.
- **Least privilege.** The module doesn't create an IAM role. Add an instance profile with only the permissions the workload needs.

## Known gaps (on purpose, for a first version)

- No VPC or subnet creation. Pass existing private subnets.
- The AMI must already have the NVIDIA driver. The module doesn't build one.
- No IAM instance profile yet.
- No remote state backend. Use an S3 backend with locking before using this with a team.
