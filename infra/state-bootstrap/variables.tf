variable "aws_region" {
  description = "Region for the Terraform state bucket. Keep this aligned with the main infrastructure region."
  type        = string
  default     = "ap-southeast-2"
}
