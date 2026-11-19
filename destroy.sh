#!/usr/bin/env bash
# Default:  removes the running infrastructure but KEEPS user accounts and files
#           (the S3 buckets and Cognito user pool are retained).
# --purge:  ALSO permanently deletes all files and all user accounts.
set -euo pipefail

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

P="${PRIMARY_REGION:-us-east-1}"
S="${SECONDARY_REGION:-us-west-2}"
APP="${APP_NAME:-cloudfiles}"
ACCT="$(aws sts get-caller-identity --query Account --output text)"
PB="$APP-$ACCT-$P"
SB="$APP-$ACCT-$S"

if [ "$PURGE" = 1 ]; then
  read -r -p "This PERMANENTLY deletes all files and users. Type 'delete' to continue: " ok
  [ "$ok" = "delete" ] || { echo "Cancelled."; exit 1; }
  POOL="$(aws cloudformation describe-stacks --region "$P" --stack-name "$APP-auth" \
    --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text 2>/dev/null || true)"
fi

echo "Deleting CloudFront stack (takes a few minutes)..."
aws cloudformation delete-stack --region "$P" --stack-name "$APP-cdn"
aws cloudformation wait stack-delete-complete --region "$P" --stack-name "$APP-cdn"

for r in "$P" "$S"; do
  aws cloudformation delete-stack --region "$r" --stack-name "$APP-region"
done
for r in "$P" "$S"; do
  aws cloudformation wait stack-delete-complete --region "$r" --stack-name "$APP-region"
done
aws cloudformation delete-stack --region "$P" --stack-name "$APP-auth"
aws cloudformation wait stack-delete-complete --region "$P" --stack-name "$APP-auth"

if [ "$PURGE" = 1 ]; then
  echo "Purging retained data..."
  python3 - "$PB" "$P" "$SB" "$S" <<'PY'
import sys, boto3
a = sys.argv[1:]
for bucket, region in zip(a[0::2], a[1::2]):
    try:
        b = boto3.resource("s3", region_name=region).Bucket(bucket)
        b.object_versions.delete()
        b.delete()
        print("deleted bucket", bucket)
    except Exception as e:
        print("skip", bucket, e)
PY
  if [ -n "${POOL:-}" ] && [ "$POOL" != "None" ]; then
    aws cognito-idp delete-user-pool --region "$P" --user-pool-id "$POOL"
    echo "deleted user pool $POOL"
  fi
  echo "Everything removed."
else
  echo "Infrastructure removed. Files and user accounts were KEPT:"
  echo "  buckets: $PB, $SB"
  echo "  user pool in $P (find it in the Cognito console)"
  echo "Run './destroy.sh --purge' to delete those too and stop all storage costs."
fi
