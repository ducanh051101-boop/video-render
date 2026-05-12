# Hướng dẫn bàn giao Workflow tạo video AI từ link Facebook

Workflow tự động: scrape FB video → AI prompt generation → Max Studio image+video gen → ffmpeg merge + Whisper subtitle → Drive upload.

## 📋 Tổng quan các component

| Component | Vai trò | Provider |
|---|---|---|
| **Google Sheet** | Quản lý input/output, prompts, logs | Google Workspace |
| **Google Drive** | Lưu video output | Google Workspace |
| **n8n** | Orchestration (8 workflows) | Self-host VPS hoặc n8n.cloud |
| **GitHub repo (Public)** | CI runner cho ffmpeg render | GitHub free |
| **OpenAI API** | Whisper transcribe + AI Agent | OpenAI |
| **Gemini API** | Analyze video (qua n8n LangChain) | Google AI Studio |
| **Apify** | Scrape Facebook video | Apify |
| **Max Studio** | Generate image (Nano_Banana_Pro) + video (Veo_3.1-Fast) | max-studio.store |
| **Telegram Bot** | Control workflow + push notification | BotFather |
| **Zalo** | Notification cho workflow khác (không phải video AI) | Zalo Bot Tools |
| **catbox.moe** | Public temp host cho video render output | Free, no account |

## 🤖 8 Workflows trong n8n

| # | Workflow | Vai trò |
|---|---|---|
| 1 | **AI Prompt Generator → Sheet** | Sub-workflow chính: Apify → Gemini → AI Agent → Max Studio → Trigger render |
| 2 | **Video Batch Dispatcher** | Cron 1 phút, pick rows `Tạo Prompt` (max 3 parallel + cooldown 2 phút) |
| 3 | **Render Callback Handler** | Webhook nhận callback GitHub Actions → upload Drive → push Telegram |
| 4 | **Error Trigger** | Global error: video AI → Telegram, khác → Zalo |
| 5 | **Stuck Row Sweeper** | Cron 10 phút: mark rows stuck > 30 phút thành Lỗi |
| 6 | **Telegram Bot Controller** | Bot xử lý `/submit`, `/status`, `/retry`, `/regen`, `/cancel`, `/delete`, `/list`, `/stats`, `/help` + inline keyboard |
| 7 | **Daily Summary Push** | Cron 22:00 VN: báo cáo ngày qua Telegram |
| 8 | **Telegram Bot Health Monitor** | Cron 5 phút: check Telegram webhook, alert Zalo nếu bot chết |

---

## 🔑 Tài khoản cần đăng ký (người mới)

### Bắt buộc

1. **Google account** (cùng cho Sheet + Drive)
2. **n8n account**
   - Self-host VPS (DigitalOcean, Hetzner, ~$5/tháng)
   - Hoặc thuê nhà cung cấp Việt Nam (vd dhsywwqop.datadex.vn)
   - Hoặc n8n.cloud ($20/tháng)
   - **Yêu cầu**: phải có public URL HTTPS để webhook callback hoạt động
3. **OpenAI API** — https://platform.openai.com → API keys → tạo key (cần nạp $5+)
4. **Apify** — https://apify.com → tạo account, lấy API token
5. **Max Studio** — https://max-studio.shop → đăng ký, lấy API key + nạp credit
6. **GitHub account** — tạo Personal Access Token (PAT)

### Optional

7. **Gemini API** — https://aistudio.google.com (free tier OK)
8. **Zalo Bot** — n8n-nodes-zalo-tools (thông báo cho workflow ngoài video AI)
9. **Telegram Bot** — @BotFather → /newbot → Bot Token; lấy Chat ID qua @userinfobot

---

## 📝 Quy trình bàn giao

### Bước 1: Chuẩn bị tài khoản (người mới)

- [ ] Đăng ký 6 account bắt buộc ở trên
- [ ] Nạp credit: OpenAI $5+, Max Studio (xem giá tại dashboard)
- [ ] Có VPS hoặc n8n.cloud chạy được

### Bước 2: Setup Google Sheet (người mới)

Tạo Spreadsheet mới tên "AI Prompts - Viral Video Clones" với 2 tab:

**Tab `Source` - 10 cột:**
| Col | Header |
|---|---|
| A | Tên video |
| B | Source URL |
| C | Status |
| D | Mã video |
| E | Created At |
| F | Processed At |
| G | Video Hoàn Thiện |
| H | Lỗi |
| I | Execution ID |
| J | Credits Used |

**Tab `Prompts` - 11 cột:**
| Col | Header |
|---|---|
| A | Mã video |
| B | Tên video |
| C | Source |
| D | Scene # |
| E | Scene Name |
| F | Image Prompt |
| G | Video Prompt |
| H | Created At |
| I | Scene Video URL |
| J | Row Key |
| K | Scene Image URL |

→ Copy **Spreadsheet ID** từ URL (chuỗi giữa `/d/` và `/edit`).

### Bước 3: Setup Google Drive folder

- Tạo folder mới (vd "Dich video")
- Mở folder, copy **Folder ID** từ URL.

### Bước 4: Fork GitHub repo

- Fork https://github.com/ducanh051101-boop/video-render về account mới
- **Đảm bảo repo Public** (free Actions unlimited)
- Vào Settings → Secrets → New repository secret:
  - Name: `OPENAI_API_KEY`
  - Value: API key của OpenAI
- Vào https://github.com/settings/tokens → Generate new token (classic):
  - Scopes: `repo`, `workflow`
  - Copy token (PAT) — sẽ dùng ở n8n

### Bước 5: Export workflows từ n8n cũ

Người cũ (chủ hiện tại) làm:
- Vào n8n, mở từng workflow → menu `⋯` → **Download**
- 8 file JSON cần export:
  - `AI Prompt Generator -> Sheet.json`
  - `Video Batch Dispatcher.json`
  - `Render Callback Handler.json`
  - `Error Trigger.json`
  - `Stuck Row Sweeper.json`
  - `Telegram Bot - Video AI Controller.json`
  - `Daily Summary Push.json`
  - `Telegram Bot Health Monitor.json`
- Gửi 8 file cho người mới

### Bước 6: Import workflows vào n8n mới (người mới)

- Vào n8n mới → từng workflow → menu `⋯` → **Import from File** → chọn JSON
- Sau khi import: workflow chưa active, credentials chưa link

### Bước 7: Setup credentials trong n8n mới

Vào menu **Credentials** → tạo từng cái:

| Credential | Type | Cần điền |
|---|---|---|
| Google Sheets OAuth2 | Google Sheets OAuth2 API | Sign in với Google account mới |
| Google Drive OAuth2 | Google Drive OAuth2 API | Sign in với Google account mới |
| Apify API | Header Auth | Name=`Authorization`, Value=`Bearer <APIFY_TOKEN>` |
| Max Studio API | Header Auth | Name=`X-API-Key`, Value=`<MAX_STUDIO_KEY>` |
| GitHub PAT | Header Auth | Name=`Authorization`, Value=`Bearer <GITHUB_PAT>` |
| Telegram Bot | Telegram API | Access Token từ @BotFather (vd `8797508063:AAGZ...`) |
| OpenAI | OpenAI API | API key OpenAI |
| Gemini (Google AI) | Google Gemini (PaLM) API | API key |
| Zalo | Zalo API (community node) | Bot token |

### Bước 8: Update các reference trong workflow nodes

Sau import, các node có ID cũ. Phải update:

#### Trong `AI Prompt Generator -> Sheet`:
- **Track Execution, Append to Prompts Sheet, Read Existing Prompts, Save Image URL, Save Video URL, Mark Done**: chọn Spreadsheet ID + sheet name "Prompts"/"Source", credential Google Sheets mới
- **Apify Run**: credential Apify mới
- **Analyze video**: credential Gemini mới
- **AI Agent + OpenAI Chat Model**: credential OpenAI mới
- **Text to Image, Image to Video, Poll Image/Video Tasks**: credential Max Studio mới + sửa `API_KEY` constant trong Poll Code
- **Trigger GitHub Render**: sửa URL → `https://api.github.com/repos/<NEW_OWNER>/video-render/actions/workflows/render.yml/dispatches`, credential GitHub PAT mới
- **Build Render Payload Code**: sửa `callback_url` → URL webhook của Render Callback Handler mới (lấy sau khi import + active workflow đó)

#### Trong `Video Batch Dispatcher`:
- **Read Source, Claim Pending Batch**: sửa Spreadsheet ID
- **Execute Sub-Workflow**: chọn lại workflow ID của AI Prompt Generator -> Sheet đã import

#### Trong `Render Callback Handler`:
- **Mark Done, Mark Render Error, Upload Final to Drive**: sửa Sheet ID + Drive folder ID
- **Render Webhook**: tự cấp URL mới khi save (vd `https://<n8n-host>/webhook/render-callback`)
- **Zalo Notify Error**: credential Zalo + threadId mới

#### Trong `Error Trigger`:
- **Read Source For Error, Mark Error In Sheet**: sửa Sheet ID
- **Zalo Send Message**: credential + threadId mới
- **IF AI Prompt Gen**: sửa workflow ID (rightValue) thành ID workflow `AI Prompt Generator -> Sheet` mới

#### Trong `Stuck Row Sweeper`:
- **Read Source, Mark Stuck As Error**: sửa Sheet ID + credential

#### Trong `Telegram Bot - Video AI Controller`:
- **Parse Command** Code: sửa mảng `ALLOWED = [8665491883]` thành Chat ID của bạn (từ @userinfobot)
- **Tất cả Sheet nodes**: sửa Spreadsheet ID
- **Tất cả Telegram nodes**: chọn credential Telegram mới
- **Send Submit Error/Refused/...**: chatId dùng `={{ $json.chatId }}` (không sửa)

#### Trong `Daily Summary Push`:
- **Calculate Summary** Code: sửa `chatId: 8665491883` thành Chat ID của bạn
- **Read Source**: sửa Sheet ID + credential
- **Send Summary**: credential Telegram mới

#### Trong `Telegram Bot Health Monitor`:
- **Check Telegram Webhook** URL: thay bot token cũ (`8797508063:AAG...`) bằng token mới
- **Evaluate Health**: không cần sửa
- **Zalo Bot Down Alert**: credential Zalo mới + threadId

#### Trong `Error Trigger` → `IF Video AI Workflow`:
- Sửa mảng `['atKyen8rDb6opEzh', ...]` thành 5 workflow ID video AI mới (sau khi import)

### Bước 9: Update render.js cho repo mới

- Mở `render.js` → tìm `litterbox.catbox.moe` (default OK, không cần đổi)
- Không có gì đặc thù với owner — không cần đổi

### Bước 10: Update Build Render Payload's callback URL

Sau khi Render Callback Handler active, lấy webhook URL:
- Mở Render Callback Handler → click "Render Webhook" → copy "Production URL"
- Mở `AI Prompt Generator -> Sheet` → "Build Render Payload" Code → sửa dòng:
  ```js
  callback_url: 'https://<NEW_N8N_HOST>/webhook/render-callback'
  ```

### Bước 11: Active workflows

Active từng workflow theo thứ tự:
1. Error Trigger
2. Stuck Row Sweeper
3. Render Callback Handler
4. AI Prompt Generator -> Sheet
5. Telegram Bot Controller
6. Daily Summary Push
7. Telegram Bot Health Monitor
8. Video Batch Dispatcher (cuối cùng)

**Lưu ý Telegram Bot**:
- Sau khi active, n8n tự setWebhook với URL `/webhook/<workflowId>/telegramtrigger/webhook`
- Verify: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` → URL không được có space hoặc `last_error`
- Gửi `/help` từ Telegram → bot phải reply menu trong 5s

### Bước 12: Test smoke

- Thêm 1 row vào Source: Source URL = link FB reel public, Status = `Tạo Prompt`
- Đợi 1 phút → Dispatcher pick → Sub-workflow chạy
- Theo dõi Sheet Status thay đổi: Tạo Prompt → Đang tạo → (sau ~5-10 phút) → Đã tạo
- Cột `Video Hoàn Thiện` có link Drive → mở video xem chạy đúng

---

## 📦 Files trong repo cần biết

```
video-render/
├── .github/workflows/render.yml    # GitHub Actions definition
├── render.js                        # Main render script
├── package.json                     # Node 20 metadata
├── README.md                        # User-facing readme
└── HANDOVER.md                      # Tài liệu này
```

---

## 🐛 Troubleshooting common errors

| Lỗi | Nguyên nhân | Fix |
|---|---|---|
| `URL parameter must be a string, got undefined` | Reference $json.field bị mất sau Sheet update | Dùng itemMatching hoặc trace upstream |
| `Column names were updated after the node's setup` | Schema node không khớp Sheet | Update schema trong Sheet node |
| `Service unavailable - try again later` | Max Studio 503 transient | Đã có handling, retry hoặc đợi |
| `Apify failed cho URL: Processing failed` | URL FB private/copyright/region-blocked | Đổi URL khác |
| `Task execution timed out after 300 seconds` | Code node Task Runner limit | Giảm MAX_ATTEMPTS trong Poll nodes |
| `GitHub Actions job cancelled (timeout)` | Render quá 25 phút | Tăng timeout trong render.yml hoặc optimize |
| `helpers.httpRequestWithAuthentication is not supported` | Code node Task Runner không cho | Dùng `this.helpers.httpRequest` thay |

---

## 💰 Chi phí vận hành dự kiến

| Service | Cost per 100 video | Note |
|---|---|---|
| OpenAI Whisper | ~$0.60 | $0.006/phút audio |
| OpenAI AI Agent | ~$10-20 | $0.10-0.20/video |
| Gemini Analyze | ~$5 | $0.05/video |
| Apify FB scrape | ~$5 | $0.05/video |
| Max Studio Image | tùy plan | 0.5 credit/scene × ~3-5 scenes |
| Max Studio Video | tùy plan | 1 credit/scene |
| GitHub Actions | $0 | Public repo unlimited |
| Drive storage | $0 | Trong free quota |
| n8n VPS | $5-20/tháng | Tùy provider |
| **Tổng** | **~$25-50** + Max Studio credits | |

---

## 📞 Liên hệ support

- n8n: https://community.n8n.io
- Max Studio: support qua dashboard
- OpenAI: status.openai.com

---

> Bàn giao: 2026-05-07
> Owner cũ: ducanh051101@gmail.com
> Repo gốc: ducanh051101-boop/video-render
