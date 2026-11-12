#!/usr/bin/env bash
# Hard spending cap for a Google Cloud project.
# Creates a budget that, once exceeded, makes a Cloud Run function switch OFF billing
# for the project, so nothing more can be charged.
#
# Run in Google Cloud Shell:
#   bash setup.sh YOUR_PROJECT_ID [BUDGET_AMOUNT]      (default budget: 1, in your billing currency)
set -euo pipefail

PROJECT_ID="${1:?Usage: bash setup.sh YOUR_PROJECT_ID [BUDGET_AMOUNT]}"
BUDGET="${2:-1}"
REGION="europe-west1"
TOPIC="billing-stop"
SA_NAME="billing-stopper"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
HERE="$(cd "$(dirname "$0")" && pwd)"

gcloud config set project "$PROJECT_ID" >/dev/null

BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)' | sed 's|billingAccounts/||')"
if [ -z "$BILLING_ACCOUNT" ]; then echo "Project $PROJECT_ID has no billing account linked." >&2; exit 1; fi
CURRENCY="$(gcloud billing accounts describe "$BILLING_ACCOUNT" --format='value(currencyCode)' 2>/dev/null || true)"
CURRENCY="${CURRENCY:-EUR}"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
echo "Project: $PROJECT_ID   Billing account: $BILLING_ACCOUNT   Budget: $BUDGET $CURRENCY"

echo "== Enabling required APIs (takes a minute)"
gcloud services enable pubsub.googleapis.com cloudfunctions.googleapis.com run.googleapis.com \
  cloudbuild.googleapis.com eventarc.googleapis.com artifactregistry.googleapis.com \
  cloudbilling.googleapis.com billingbudgets.googleapis.com

echo "== Pub/Sub topic"
gcloud pubsub topics describe "$TOPIC" >/dev/null 2>&1 || gcloud pubsub topics create "$TOPIC"

echo "== Service account for the function"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SA_NAME" --display-name="Disables billing when budget is exceeded"
sleep 10
# allowed to unlink this project from its billing account
gcloud billing accounts add-iam-policy-binding "$BILLING_ACCOUNT" \
  --member="serviceAccount:$SA" --role="roles/billing.admin" >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA" --role="roles/billing.projectManager" --condition=None >/dev/null
# allowed to receive the Pub/Sub events
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA" --role="roles/run.invoker" --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA" --role="roles/eventarc.eventReceiver" --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" --condition=None >/dev/null

echo "== Deploying function (takes a few minutes)"
gcloud functions deploy stop-billing --gen2 --region="$REGION" --runtime=python312 \
  --source="$HERE" --entry-point=stop_billing --trigger-topic="$TOPIC" \
  --service-account="$SA" --trigger-service-account="$SA" \
  --set-env-vars="PROJECT_ID=$PROJECT_ID" --memory=256Mi --max-instances=1 --quiet

echo "== Budget"
if gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" --format='value(displayName)' | grep -qx "Hard cap $PROJECT_ID"; then
  echo "Budget already exists, leaving it as is."
else
  gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" \
    --display-name="Hard cap $PROJECT_ID" --budget-amount="${BUDGET}${CURRENCY}" \
    --filter-projects="projects/$PROJECT_ID" \
    --threshold-rule=percent=0.5 --threshold-rule=percent=1.0 \
    --notifications-rule-pubsub-topic="projects/$PROJECT_ID/topics/$TOPIC"
fi

echo "== Safe test (cost 0 is below budget, so billing stays ON)"
gcloud pubsub topics publish "$TOPIC" --message='{"costAmount": 0, "budgetAmount": 1}' >/dev/null
echo "Waiting 60 s for the function log…"
sleep 60
gcloud functions logs read stop-billing --gen2 --region="$REGION" --limit=10 || true

echo
echo "Done. If the log above shows 'within budget, nothing to do', the cap is active."
echo "Once costs pass $BUDGET $CURRENCY, billing is switched off and Street View stops until you re-enable it."
