# video-render

GitHub Actions worker để ghép scene + burn phụ đề tiếng Việt cho workflow n8n `AI Prompt Generator -> Sheet`.

## Hoạt động

1. n8n trigger `workflow_dispatch` qua GitHub API với `video_id`, `scenes` (JSON array URL), `callback_url`.
2. Action chạy `render.js`:
   - Tải tất cả scenes
   - Ghép bằng `ffmpeg concat`
   - Trích audio → POST OpenAI Whisper API → nhận SRT (tiếng Việt)
   - Burn SRT vào video bằng `ffmpeg subtitles` filter
   - Upload `final.mp4` lên `litterbox.catbox.moe` (host công khai 24h)
   - POST callback về n8n với `final_url`
3. n8n download URL → upload lên Drive → ghi link Sheet.

## Setup

### 1. Push repo lên GitHub (PUBLIC để Actions miễn phí không giới hạn)

```bash
cd video-render
git init
git add .
git commit -m "Initial render worker"
git branch -M main
git remote add origin https://github.com/ducanh2605/video-render.git
git push -u origin main
```

Đảm bảo repo **Public** (Settings → General → Danger Zone → Change visibility).

### 2. Tạo OpenAI API key
- platform.openai.com → API Keys → Create new
- Copy `sk-...`

### 3. Add OpenAI key vào GitHub Secrets
- Repo Settings → Secrets and variables → Actions → New repository secret
- Name: `OPENAI_API_KEY`
- Value: `sk-...`

### 4. Tạo GitHub Personal Access Token (cho n8n trigger)
- github.com/settings/tokens → Generate new token (classic)
- Scopes: `repo`, `workflow`
- Copy `ghp_...`

### 5. Setup n8n credential
Trong workflow `AI Prompt Generator -> Sheet`:
- Mở node **Trigger GitHub Render**
- Credential → Create new → Header Auth
- Name: `Authorization`
- Value: `Bearer ghp_...`
- Save & assign

### 6. Test thử
- Trong GitHub repo: tab Actions → Render Video → Run workflow
- Inputs:
  - `video_id`: `TEST-001`
  - `scenes`: `["https://example.com/scene1.mp4","https://example.com/scene2.mp4"]`
  - `callback_url`: bất kỳ (vd webhook.site)

## Files

- `.github/workflows/render.yml` — Actions workflow definition
- `render.js` — Logic ghép + transcribe + burn + upload + callback
- `package.json` — Node 20 (no deps, dùng built-in `fetch`)

## Chi phí

- GitHub Actions: **Free unlimited** cho public repo
- OpenAI Whisper: ~$0.006/phút audio (~150 VND/video 1 phút)
- Litterbox.catbox.moe upload: **Free**, file giữ 24h (đủ để n8n download về)

## Hạn chế

- File output upload lên `litterbox.catbox.moe` chỉ giữ 24h. n8n callback luôn download ngay nên không vấn đề.
- Litterbox max 1GB/file (video 1 phút thường <20MB nên dư sức).
- Concat re-encode để chuẩn codec — chậm hơn `-c copy` nhưng tránh lỗi format khác nhau giữa scenes.
