#!/usr/bin/env bash
# One-command deploy of the whole project into TWO regions.
# Requires: AWS CLI v2 configured (aws configure), run from the project folder.
set -euo pipefail

P="${PRIMARY_REGION:-us-east-1}"      # CloudFront + Cognito live here
S="${SECONDARY_REGION:-us-west-2}"
APP="${APP_NAME:-cloudfiles}"
ACCT="$(aws sts get-caller-identity --query Account --output text)"
PB="$APP-$ACCT-$P"
SB="$APP-$ACCT-$S"

deploy() { # region stack template [Key=Value ...]
  local region="$1" stack="$2" tpl="$3"; shift 3
  # A stack that failed its very first create is stuck in ROLLBACK_COMPLETE; remove it so we can retry.
  local status
  status="$(aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
  if [ "$status" = "ROLLBACK_COMPLETE" ]; then
    echo "   removing failed stack $stack from an earlier attempt..."
    aws cloudformation delete-stack --region "$region" --stack-name "$stack"
    aws cloudformation wait stack-delete-complete --region "$region" --stack-name "$stack"
  fi
  aws cloudformation deploy --region "$region" --stack-name "$stack" \
    --template-file "$tpl" --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset --parameter-overrides AppName="$APP" "$@"
}
out() { # region stack OutputKey
  aws cloudformation describe-stacks --region "$1" --stack-name "$2" \
    --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue" --output text
}

echo "== 1/6 Cognito user pool ($P)"
deploy "$P" "$APP-auth" infra/auth.yaml
POOL="$(out "$P" "$APP-auth" UserPoolId)"
CLIENT="$(out "$P" "$APP-auth" ClientId)"
AUTH_PARAMS=(UserPoolId="$POOL" UserPoolRegion="$P" UserPoolClientId="$CLIENT")

echo "== 2/6 Backend in secondary region ($S)"
deploy "$S" "$APP-region" infra/region.yaml StageName=api-b "${AUTH_PARAMS[@]}"

echo "== 3/6 Backend in primary region ($P), replicating to $S"
deploy "$P" "$APP-region" infra/region.yaml StageName=api-a "${AUTH_PARAMS[@]}" ReplicaBucketName="$SB"

echo "== 4/6 CloudFront"
CACHE_POLICY="$(aws cloudfront list-cache-policies --type managed \
  --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='Managed-CachingDisabled'].CachePolicy.Id | [0]" --output text)"
ORIGIN_POLICY="$(aws cloudfront list-origin-request-policies --type managed \
  --query "OriginRequestPolicyList.Items[?OriginRequestPolicy.OriginRequestPolicyConfig.Name=='Managed-AllViewerExceptHostHeader'].OriginRequestPolicy.Id | [0]" --output text)"
if [ -z "$CACHE_POLICY" ] || [ "$CACHE_POLICY" = "None" ] || [ -z "$ORIGIN_POLICY" ] || [ "$ORIGIN_POLICY" = "None" ]; then
  echo "Could not find the managed CloudFront policies in this account." >&2; exit 1
fi
deploy "$P" "$APP-cdn" infra/cdn.yaml \
  PrimaryRegion="$P" SecondaryRegion="$S" AuthRegion="$P" \
  PrimaryBucket="$PB" SecondaryBucket="$SB" \
  CachePolicyId="$CACHE_POLICY" OriginRequestPolicyId="$ORIGIN_POLICY" \
  PrimaryApiDomain="$(out "$P" "$APP-region" ApiDomain)" \
  SecondaryApiDomain="$(out "$S" "$APP-region" ApiDomain)"
DOMAIN="$(out "$P" "$APP-cdn" DomainName)"

echo "== 5/6 Turn on two-way replication and lock CORS to https://$DOMAIN"
deploy "$S" "$APP-region" infra/region.yaml StageName=api-b "${AUTH_PARAMS[@]}" \
  ReplicaBucketName="$PB" AllowedOrigin="https://$DOMAIN"
deploy "$P" "$APP-region" infra/region.yaml StageName=api-a "${AUTH_PARAMS[@]}" \
  ReplicaBucketName="$SB" AllowedOrigin="https://$DOMAIN"

echo "== 6/6 Upload the website (it replicates to $S automatically)"
cat > site/config.js <<EOF
window.CONFIG = {
  authRegion: "$P",
  clientId: "$CLIENT",
  apis: ["/api-a", "/api-b"],
  maxBytes: 52428800
};
EOF
aws s3 cp site "s3://$PB/site/" --recursive --region "$P" --only-show-errors

echo
echo "Done. Open: https://$DOMAIN"
echo "(CloudFront can take a few minutes to finish deploying the first time.)"
