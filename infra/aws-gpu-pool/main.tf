provider "aws" {
  region = var.region

  default_tags {
    tags = merge(var.tags, { module = "aws-gpu-pool", managed-by = "terraform" })
  }
}

# No inbound rules. The pool is reached through its job queue or an SSM session, not an open port.
resource "aws_security_group" "pool" {
  name        = "${var.name}-sg"
  description = "GPU pool: no inbound, outbound for package and model downloads"
  vpc_id      = data.aws_subnet.first.vpc_id

  egress {
    description = "HTTPS out for packages and model downloads"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

data "aws_subnet" "first" {
  id = var.subnet_ids[0]
}

resource "aws_launch_template" "pool" {
  name_prefix   = "${var.name}-"
  image_id      = var.ami_id
  instance_type = var.instance_type

  # IMDSv2 only. Stops a compromised process from using the old metadata endpoint.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = 100
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  vpc_security_group_ids = [aws_security_group.pool.id]

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name}-node" }
  }
}

resource "aws_autoscaling_group" "pool" {
  name                = "${var.name}-asg"
  min_size            = 0
  max_size            = var.max_size
  desired_capacity    = 0
  vpc_zone_identifier = var.subnet_ids
  health_check_type   = "EC2"

  launch_template {
    id      = aws_launch_template.pool.id
    version = "$Latest"
  }

  tag {
    key                 = "Name"
    value               = "${var.name}-node"
    propagate_at_launch = true
  }
}

# Scale to zero outside working hours.
resource "aws_autoscaling_schedule" "scale_down" {
  scheduled_action_name  = "${var.name}-scale-down"
  autoscaling_group_name = aws_autoscaling_group.pool.name
  recurrence             = var.scale_down_cron
  min_size               = 0
  max_size               = var.max_size
  desired_capacity       = 0
}

resource "aws_autoscaling_schedule" "scale_up" {
  count = var.scale_up_cron == "" ? 0 : 1

  scheduled_action_name  = "${var.name}-scale-up"
  autoscaling_group_name = aws_autoscaling_group.pool.name
  recurrence             = var.scale_up_cron
  min_size               = 0
  max_size               = var.max_size
  desired_capacity       = var.desired_when_on
}

# Cost guardrail: email alerts before the bill surprises you.
resource "aws_budgets_budget" "monthly" {
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
