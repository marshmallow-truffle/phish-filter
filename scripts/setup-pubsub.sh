#!/usr/bin/env bash
# scripts/setup-pubsub.sh
# One-time setup for GCP Pub/Sub topic and subscription.
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID env var}"
TOPIC="email-notifications"
SUBSCRIPTION="email-worker-sub"

echo "Creating Pub/Sub topic: $TOPIC"
gcloud pubsub topics create "$TOPIC" --project="$PROJECT_ID" 2>/dev/null || echo "Topic already exists"

echo "Granting Gmail publish rights"
gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
    --project="$PROJECT_ID" \
    --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
    --role="roles/pubsub.publisher"

echo "Creating pull subscription: $SUBSCRIPTION"
gcloud pubsub subscriptions create "$SUBSCRIPTION" \
    --project="$PROJECT_ID" \
    --topic="$TOPIC" \
    --ack-deadline=60 \
    --message-retention-duration=7d \
    2>/dev/null || echo "Subscription already exists"

echo "Done. Topic: $TOPIC, Subscription: $SUBSCRIPTION"
