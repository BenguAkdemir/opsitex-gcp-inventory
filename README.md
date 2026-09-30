# GCP Compute Envanteri

Bir GCP projesindeki Compute Engine VM'lerini listeleyen, salt okunur bir envanter servisi ve dashboard.
Backend Node.js + TypeScript (Express 5), client React. Servis GCP'ye kişisel hesapla değil, sadece okuma yetkisi olan
ayrı bir service account'un kimliğiyle bağlanır.

## Çalıştırma

Gereksinimler: Node 22+, gcloud CLI, faturalandırması açık bir GCP hesabı (free trial yeterli).

### Sadece testler (GCP gerekmez)

```bash
cd server && npm ci && npm test && npm run typecheck
cd ../web && npm ci && npm test && npm run typecheck
```

Testler Google'a gitmez: gerçek Google kütüphanesi localhost'taki sahte bir Google sunucusuna yönlendirilir.

### Kendi projende uçtan uca

```bash
# 1. Kendi kullanıcınla giriş (ortamı bu kimlik kurar, servis kullanmaz)
gcloud auth login

# 2. Ortam: proje, firewall, 3 demo VM, custom role, service account, budget
export PROJECT_ID=<benzersiz-proje-id>
export USER_EMAIL=$(gcloud config get-value account)
export BILLING_ACCOUNT_ID=<gcloud billing accounts list çıktısındaki ACCOUNT_ID>
./infra/setup.sh

# 3. Servisin kimliği: kişisel hesap değil, service account'a bürünen kısa ömürlü token
gcloud auth application-default login \
  --impersonate-service-account=inventory-reader@${PROJECT_ID}.iam.gserviceaccount.com

# 4. Backend (terminal 1, repo kökünden)
cd server && echo "GCP_PROJECT_ID=${PROJECT_ID}" > .env
npm ci && npm run dev              # http://127.0.0.1:3001

# 5. Dashboard (terminal 2, repo kökünden)
cd web && npm ci && npm run dev    # http://127.0.0.1:5173
```

Bir adım eksikse servis hangisi olduğunu kendisi söyler: `.env` yoksa nasıl oluşturulacağını, ADC yoksa 3. adımdaki
komutu, impersonation'sız giriş yapıldıysa doğru komutu, IAM henüz yayılmadıysa birkaç dakika sonra tekrar denemeyi.

Temizlik: `PROJECT_ID=<proje-id> ./infra/teardown.sh` projeyi, budget'ı ve yerel ADC'yi siler.

### API

| Endpoint | Ne döner |
|---|---|
| `GET /api/connection` | Servisin hangi kimlikle bağlandığı, token scope'u, proje. Token gerçekten alınarak doğrulanır. |
| `GET /api/vms` | Normalize VM listesi + kısmi sonuç uyarıları |
| `GET /api/vms/:zone/:name` | Tek VM'in GCP'den taze hali (drawer bunu kullanır) |

Hata durumunda her endpoint aynı gövdeyi döner:
`{ error: { code, title, detail, action, command, docsUrl, retryable, requestId } }`.

## Mimari

```
Browser (React) ──/api──▶ Express 5, sadece 127.0.0.1
                            │  InventoryProvider arayüzü (sağlayıcıdan bağımsız)
                            ▼
                          GcpInventoryProvider
                            ├─ gcp.session     ADC → impersonation → kısa ömürlü token (compute.readonly)
                            ├─ gcp.normalizer  SDK objesi → NormalizedVm (allowlist)
                            └─ gcp.errors      Google hatası → okunabilir hata sözleşmesi
                            ▼
                          Compute Engine API: instances.aggregatedList, instances.get, machineTypes.get
```

Tek listeleme = bir `aggregatedList` (tüm zone'lar, sayfalı) + her farklı machine type için bir `machineTypes.get`
(sonuç process içinde cache'lenir; custom tipler isimden çözülür, API'ye gidilmez).

## GCP tarafında yaptıklarım

### Demo filosu

VM'leri rastgele değil, normalizer'ın ve UI'ın her dalını en az bir kez tetikleyecek şekilde kurdum:

| | web-01 | app-01 | batch-01 |
|---|---|---|---|
| Rol | riskli | temiz baseline | edge case |
| Konum | us-central1-a | us-central1-b | europe-west1-b |
| Dış IP | var | yok | yok |
| VM'e takılı kimlik | default SA + `cloud-platform` scope | yok | default SA + default scope'lar |
| Secure Boot | kapalı | açık | kapalı |
| Diğer | network tag `http-server` | label'lar, silme koruması | Spot, termination action STOP, Ubuntu minimal |

### Servisin kimliği

- **Ayrı service account:** `inventory-reader@<project>.iam.gserviceaccount.com`.
- **Custom role, 3 izin:** `compute.instances.list`, `compute.instances.get`, `compute.machineTypes.get`.
  `roles/compute.viewer` diskleri, ağları, firewall'ları, snapshot'ları da okur; case "en dar kapsam" dediği için kullanmadım.
- **Key dosyası yok, impersonation var:** Kullanıcıma sadece bu SA üzerinde `roles/iam.serviceAccountTokenCreator` verdim
  (proje seviyesinde değil). Kütüphane benim oturumumla 1 saatlik SA token'ı üretir; Compute API'ye giden kimlik SA'dır.
  Sızan bir key JSON'u başka hiçbir şey gerekmeden kullanılabilirdi, bu yüzden key oluşturmadım.
- **Token scope'u da dar:** Token `compute.readonly` scope'uyla istenir. Etkin yetki = IAM rolü ∩ scope,
  yani rol yanlışlıkla genişlese bile token yazma yapamaz.
- **Kullanıcı hesabı reddedilir:** ADC impersonation'sız bir kullanıcı hesabıysa servis istek atmadan
  `GCP_USER_CREDENTIALS_REJECTED` döner.
- Production'da servis Cloud Run veya GKE üzerinde bu SA'ya bağlı çalışır, impersonation adımı ortadan kalkar.

### Maliyet, güvenlik, temizlik

- **Budget:** 500 TRY, %50/%90/%100 eşik. Trial kredisi ("promotional credits") hesaplamadan çıkarıldı;
  aksi halde net maliyet hep 0 görünür ve alarm hiç çalmaz. Budget harcamayı durdurmaz, sadece uyarır.
- **Firewall:** Default VPC'de SSH tüm internete açık geliyordu; kaynağı IAP aralığına (`35.235.240.0/20`) daralttım,
  kullanılmayan RDP kuralını sildim.
- Demo dışında VM'ler durdurulmuş halde (durmuş VM envanterde `stopped` olarak görünmeye devam eder).
- **Temizlik:** `infra/teardown.sh` budget'ı (billing account'ta durur, projeyle birlikte silinmez), projeyi ve yerel ADC'yi siler.
- Ortamın tamamı `infra/setup.sh` ile tekrar kurulabilir (billing account ID ve e-posta env değişkeni, repoda yok).

## Normalizasyon

- **Allowlist:** Çıktıdaki her alan tek tek yazılır, SDK objesi asla spread edilmez. SDK objesi protobuf'ın `_natIP` gibi
  gölge alanlarını taşıyor; `metadata` silinse bile `_metadata` kalıyordu. `metadata` (ssh-keys, startup-script) secret
  içerebildiği için hiçbir koşulda dışarı çıkmaz.
- **Kimlik:** `gcp:<project>:<zone>:<instanceId>`. İsim tekrar kullanılabilir, ephemeral IP değişir
  (web-01'in IP'si bir stop/start sonrası değişti); instance ID değişmez.
- **Durum:** 12 GCP durumu 6 ortak duruma iner; ham değer `providerState` alanında kalır. GCP'de `TERMINATED`
  durdurulmuş demek, silinmiş değil. Tanınmayan yeni bir durum `unknown` olur, listeyi düşürmez.
- **Tipler:** int64 alanlar SDK'dan string gelir (`"10"`), zaman damgaları `-07:00` offset'li gelir; hepsi sayıya
  ve UTC ISO'ya çevrilir.
- **CPU/RAM** instance'ta yok, `machineTypes.get` ile zenginleştirilir. Shared-core tipler UI'da "2 vCPU (shared)" olarak
  gösterilir. Bilgi alınamazsa `null` olur, tahmin edilmez.
- **OS** instance'ta yok, boot disk lisansından okunur (`debian-13-trixie` → "Debian 13 (trixie)"); tanınmayan lisans ham adıyla gösterilir.
- **Kısmi sonuç:** Okunamayan zone, alınamayan machine type veya normalize edilemeyen tek VM listeyi düşürmez;
  `warnings` olarak döner ve UI'da ayrı bir banner'da gösterilir. Boş liste ile okunamayan liste hiçbir zaman aynı görünmez.

## Hata mesajları

| Kod | Ne zaman | Kullanıcıya önerilen |
|---|---|---|
| `GCP_CREDENTIALS_NOT_FOUND` | Makinede ADC yok | Impersonation'lı `gcloud auth application-default login` komutu |
| `GCP_CREDENTIALS_EXPIRED` | gcloud oturumu düşmüş (`invalid_grant`) | Aynı login komutu |
| `GCP_USER_CREDENTIALS_REJECTED` | ADC kişisel hesap | Impersonation ile yeniden oluşturma |
| `GCP_IMPERSONATION_DENIED` | Token Creator yok veya henüz yayılmadı | Binding komutu + "1-2 dk bekleyin" (retryable) |
| `GCP_PERMISSION_DENIED` | SA'da izin eksik ya da proje var ama SA'nın erişimi yok (canlıda 403) | Eksik izin adı + `gcloud iam roles update ... --add-permissions=<izin>` |
| `GCP_API_DISABLED` | Compute API kapalı | `gcloud services enable compute.googleapis.com` + activation linki |
| `GCP_PROJECT_NOT_FOUND` | Proje ID'si hiç yok (canlıda 404) | `.env` kontrolü |
| `GCP_UNREACHABLE` | DNS, ağ, zaman aşımı | Bağlantı kontrolü (retryable) |
| `GCP_RATE_LIMITED` | Kota | Bekleyip tekrar deneme (retryable) |
| `SERVER_UNREACHABLE` | Client backend'e ulaşamıyor | `cd server && npm run dev` (sorunun GCP'de olmadığı açıkça yazılır) |

Eksik izin adı önce Google'ın `ErrorInfo` metadata'sından, yoksa mesajdan okunur. Compute REST transport'unda 403 hataları
ayrıştırılmadan geliyor (hata mesajı JSON gövdesinin kendisi); translator bu gövdeyi kendisi çözer.
Hata çevirisi, gerçek `@google-cloud/compute` ve `google-auth-library` kodu sahte bir Google API sunucusuna
bağlanarak test ediliyor (`server/test/gcp.provider.test.ts`). Böylece test edilen şey benim tahmin ettiğim hata şekli
değil, kütüphanenin gerçekten ürettiği hata.

Ağ hatalarında kütüphanenin varsayılan davranışı 10 dakika boyunca yeniden denemek; çağrılara 15 saniyelik toplam süre sınırı koydum.

## Nerede takıldım

- **VM içinden gcloud "çalışıyordu", ama yanlış kimlikle.** web-01'de `gcloud init` çalıştırılmış, Owner yetkili kişisel
  hesabım diskte kalmıştı. VM'in gerçek kimliğini `gcloud auth list` değil metadata server söyler. Hesabı revoke ettim;
  VM içinde bir daha kişisel kimlik kullanmadım.
- **Rol yeni verilince impersonation reddedildi.** IAM değişikliğinin yayılması ~2 dakika sürdü. `setup.sh` bu yüzden
  binding'den sonra retry ile bekliyor; hata mesajı da bu ihtimali söylüyor.
- **gcloud izin hatasını "Listed 0 items" olarak gösterdi.** "Hiç disk yok" ile "okuyamadım" aynı görünüyordu.
  Bu servis ikisini asla aynı göstermiyor.
- **Ephemeral IP stop/start'ta bir kez aynı kaldı, bir kez değişti.** Garanti yok; IP kimlik olarak kullanılamaz.
- **Compute client ADC bulamayınca kendi içinde yakalanmayan bir promise rejection üretiyor ve reddedilen durumu
  cache'liyor.** Kimliği client'ı oluşturmadan önce kendim çözüyorum, oturumu hata sonrası sıfırlıyorum:
  ADC düzeltildikten sonra servisi yeniden başlatmadan "Tekrar dene" çalışıyor.

## Baştan yapsam

- Default VPC yerine sadece gereken kurallarla kendi VPC'mi kurardım (default kurallar demo için bile fazla geniş).
- Kalıcı bir ortam olsaydı gcloud script yerine Terraform kullanırdım.
- Hataları yanlış config ile canlıda da denerdim, daha erken. Başkasına ait bir proje ID'siyle gelen 403'te servis
  "izin eksik" diyor ve role komutu öneriyor, oysa sorun proje ID'si. Sıradaki adım: 403'te service account'un projesi
  ile `GCP_PROJECT_ID` farklıysa önce proje ID'sinden şüphelenmek ve detayda gerçekten kullanılan kimliği göstermek.
- Büyük ölçekte (çok proje, binlerce VM) Compute API'yi tek tek taramak yerine Cloud Asset Inventory,
  kısa TTL'li cache ve proje başına eşzamanlılık sınırı kullanırdım.
