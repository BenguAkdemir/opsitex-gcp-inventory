#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID gerekli (ör. servicepark-case)}"
: "${USER_EMAIL:?USER_EMAIL gerekli: service account kimliğine bürünecek kullanıcı}"
BILLING_ACCOUNT_ID="${BILLING_ACCOUNT_ID:-}"

SA_NAME="inventory-reader"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
ROLE_ID="inventoryReader"
IAP_RANGE="35.235.240.0/20"
DEFAULT_SCOPES="devstorage.read_only,logging.write,monitoring.write,service.management.readonly,servicecontrol,trace.append"

step() { printf '\n==> %s\n' "$*"; }
exists() { "$@" >/dev/null 2>&1; }

step "Proje: ${PROJECT_ID}"
if ! exists gcloud projects describe "${PROJECT_ID}"; then
  gcloud projects create "${PROJECT_ID}"
  : "${BILLING_ACCOUNT_ID:?Yeni proje için BILLING_ACCOUNT_ID gerekli}"
  gcloud billing projects link "${PROJECT_ID}" --billing-account="${BILLING_ACCOUNT_ID}"
fi
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
DEFAULT_COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

step "API'ler: Compute, IAM Credentials, Billing Budgets"
gcloud services enable compute.googleapis.com iamcredentials.googleapis.com billingbudgets.googleapis.com \
  --project="${PROJECT_ID}"

step "Firewall: SSH sadece IAP aralığından, RDP kapalı, HTTP sadece http-server tag'ine"
gcloud compute firewall-rules update default-allow-ssh --project="${PROJECT_ID}" --source-ranges="${IAP_RANGE}"
if exists gcloud compute firewall-rules describe default-allow-rdp --project="${PROJECT_ID}"; then
  gcloud compute firewall-rules delete default-allow-rdp --project="${PROJECT_ID}" --quiet
fi
if ! exists gcloud compute firewall-rules describe default-allow-http --project="${PROJECT_ID}"; then
  gcloud compute firewall-rules create default-allow-http --project="${PROJECT_ID}" --network=default \
    --direction=INGRESS --allow=tcp:80 --source-ranges=0.0.0.0/0 --target-tags=http-server
fi

create_vm() {
  local name="$1" zone="$2"
  shift 2
  if exists gcloud compute instances describe "${name}" --zone="${zone}" --project="${PROJECT_ID}"; then
    echo "${name} zaten var, atlanıyor"
  else
    gcloud compute instances create "${name}" --project="${PROJECT_ID}" --zone="${zone}" \
      --boot-disk-size=10GB --boot-disk-type=pd-standard "$@"
  fi
}

step "web-01: riskli demo (dış IP, default SA + cloud-platform scope, Secure Boot kapalı, label yok)"
create_vm web-01 us-central1-a \
  --machine-type=e2-micro \
  --image-family=debian-13 --image-project=debian-cloud \
  --service-account="${DEFAULT_COMPUTE_SA}" --scopes=cloud-platform \
  --tags=http-server \
  --no-shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --description="Public web server (intentionally risky demo)"

step "app-01: temiz baseline (dış IP yok, SA yok, Secure Boot açık, label'lı, silme korumalı)"
create_vm app-01 us-central1-b \
  --machine-type=e2-micro \
  --image-family=debian-13 --image-project=debian-cloud \
  --no-address \
  --no-service-account --no-scopes \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --deletion-protection \
  --labels=env=prod,team=backend,owner=bengu \
  --description="Internal app server (clean baseline demo)"

step "batch-01: edge case (Spot + STOP, başka region, default SA + default scope'lar, Ubuntu minimal)"
create_vm batch-01 europe-west1-b \
  --machine-type=e2-medium \
  --image-family=ubuntu-minimal-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --no-address \
  --provisioning-model=SPOT --instance-termination-action=STOP \
  --service-account="${DEFAULT_COMPUTE_SA}" \
  --scopes="${DEFAULT_SCOPES}" \
  --labels=env=dev,team=data,owner=bengu \
  --description="Nightly batch worker (spot, stopped by default)"
gcloud compute instances stop batch-01 --zone=europe-west1-b --project="${PROJECT_ID}"

step "Custom role ${ROLE_ID}: sadece okuma, 3 izin"
if ! exists gcloud iam roles describe "${ROLE_ID}" --project="${PROJECT_ID}"; then
  gcloud iam roles create "${ROLE_ID}" --project="${PROJECT_ID}" \
    --title="Inventory Reader" \
    --description="Read-only access for the VM inventory service" \
    --permissions=compute.instances.list,compute.instances.get,compute.machineTypes.get \
    --stage=GA
fi

step "Service account ${SA_EMAIL}"
if ! exists gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}"; then
  gcloud iam service-accounts create "${SA_NAME}" --project="${PROJECT_ID}" \
    --display-name="Inventory reader (read-only)"
fi

step "Rol projeye SA için bağlanıyor"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="projects/${PROJECT_ID}/roles/${ROLE_ID}" \
  --condition=None >/dev/null

step "Token Creator sadece bu SA üzerinde, sadece ${USER_EMAIL} için"
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" --project="${PROJECT_ID}" \
  --member="user:${USER_EMAIL}" \
  --role=roles/iam.serviceAccountTokenCreator >/dev/null

step "IAM yayılması bekleniyor: impersonation ile liste denemesi"
for attempt in 1 2 3 4 5 6 7 8; do
  if output="$(gcloud compute instances list --project="${PROJECT_ID}" --impersonate-service-account="${SA_EMAIL}" \
    --format="table(name,zone.basename(),status)" 2>&1)"; then
    echo "${output}"
    break
  fi
  if [[ "${attempt}" == 8 ]]; then
    echo "${output}" >&2
    echo "Impersonation hâlâ reddediliyor; birkaç dakika sonra tekrar deneyin." >&2
    exit 1
  fi
  echo "Henüz yayılmadı, 20 sn sonra tekrar (${attempt}/8)"
  sleep 20
done

if [[ -n "${BILLING_ACCOUNT_ID}" ]]; then
  step "Budget alarmı: 500 TRY, trial kredisi maliyetten düşülmeden"
  if [[ -z "$(gcloud billing budgets list --billing-account="${BILLING_ACCOUNT_ID}" \
    --filter="displayName=${PROJECT_ID}-budget" --format='value(name)')" ]]; then
    gcloud billing budgets create \
      --billing-account="${BILLING_ACCOUNT_ID}" \
      --display-name="${PROJECT_ID}-budget" \
      --budget-amount=500TRY \
      --filter-projects="projects/${PROJECT_ID}" \
      --credit-types-treatment=include-specified-credits \
      --filter-credit-types=OTHER,SUSTAINED_USAGE_DISCOUNT,DISCOUNT,COMMITTED_USAGE_DISCOUNT,FREE_TIER,COMMITTED_USAGE_DISCOUNT_DOLLAR_BASE,SUBSCRIPTION_BENEFIT \
      --threshold-rule=percent=0.5 \
      --threshold-rule=percent=0.9 \
      --threshold-rule=percent=1.0
  fi
else
  step "BILLING_ACCOUNT_ID verilmedi: budget adımı atlandı"
fi

step "Bitti. Servisin kimliği için ADC:"
echo "gcloud auth application-default login --impersonate-service-account=${SA_EMAIL}"
