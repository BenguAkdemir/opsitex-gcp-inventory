#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID gerekli}"
BILLING_ACCOUNT_ID="${BILLING_ACCOUNT_ID:-}"

step() { printf '\n==> %s\n' "$*"; }

echo "Bu işlem ${PROJECT_ID} projesini ve içindeki her şeyi (VM, disk, firewall, service account, custom role) siler."
read -r -p "Onaylamak için proje ID'sini yazın: " answer
if [[ "${answer}" != "${PROJECT_ID}" ]]; then
  echo "Eşleşmedi, hiçbir şey silinmedi."
  exit 1
fi

if [[ -n "${BILLING_ACCOUNT_ID}" ]]; then
  step "Budget siliniyor (budget billing account'ta durur, proje silinince kendiliğinden gitmez)"
  for budget in $(gcloud billing budgets list --billing-account="${BILLING_ACCOUNT_ID}" \
    --filter="displayName=${PROJECT_ID}-budget" --format='value(name)'); do
    gcloud billing budgets delete "${budget}" --quiet
  done
else
  step "BILLING_ACCOUNT_ID verilmedi: budget'ı Billing → Budgets & alerts ekranından silin"
fi

step "Proje siliniyor (kaynaklar hemen kapanır, proje 30 gün boyunca geri alınabilir durumda kalır)"
gcloud projects delete "${PROJECT_ID}" --quiet

step "Yerel ADC dosyası ve içindeki kullanıcı refresh token'ı iptal ediliyor"
gcloud auth application-default revoke --quiet || echo "Yerel ADC bulunamadı ya da zaten iptal edilmiş."

step "Kontrol"
gcloud projects describe "${PROJECT_ID}" --format='value(lifecycleState)'
