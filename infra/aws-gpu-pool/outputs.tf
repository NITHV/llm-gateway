output "asg_name" {
  description = "Auto Scaling group name. Use this to check or change the pool with the AWS CLI."
  value       = aws_autoscaling_group.pool.name
}

output "launch_template_id" {
  description = "Launch template used for each node."
  value       = aws_launch_template.pool.id
}

output "budget_name" {
  description = "Budget that sends the cost alerts."
  value       = aws_budgets_budget.monthly.name
}
