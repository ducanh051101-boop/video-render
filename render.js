const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORK_DIR = '/tmp/render';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VIDEO_ID = process.env.VIDEO_ID;
const SCENES_JSON = process.env.SCENES_JSON;
const CALLBACK_URL = process.env.CALLBACK_URL;

if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY missing');
if (!VIDEO_ID) throw new Error('VIDEO_ID missing');
if (!SCENES_JSON) throw new Error('SCENES_JSON missing');
if (!CALLBACK_URL) throw new Error('CALLBACK_URL missing');

const sceneUrls = JSON.parse(SCENES_JSON);
console.log(`Render ${VIDEO_ID} (${sceneUrls.length} scenes)`);

fs.rmSync(WORK_DIR, { recursive: true, force: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

const sh = (cmd) => {
  console.log('$', cmd);
  execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' });
};

const shCapture = (cmd) => {
  console.log('$', cmd);
  return execSync(cmd, { shell: '/bin/bash' }).toString().trim();
};

const downloadFile = async (url, dest) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download ${url} failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`  -> ${dest} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
};

const postCallback = async (body) => {
  console.log('Callback ->', CALLBACK_URL);
  const res = await fetch(CALLBACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  console.log('Callback status:', res.status);
};

(async () => {
  try {
    // 1. Download all scenes
    const scenePaths = [];
    for (let i = 0; i < sceneUrls.length; i++) {
      const dest = path.join(WORK_DIR, `scene_${String(i + 1).padStart(2, '0')}.mp4`);
      await downloadFile(sceneUrls[i], dest);
      scenePaths.push(dest);
    }

    // 2. Concat all scenes (re-encode to ensure consistent codec/resolution)
    const concatList = path.join(WORK_DIR, 'concat.txt');
    fs.writeFileSync(concatList, scenePaths.map(p => `file '${p}'`).join('\n'));
    const merged = path.join(WORK_DIR, 'merged.mp4');
    sh(`ffmpeg -y -f concat -safe 0 -i "${concatList}" -c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 128k "${merged}"`);

    // 3. Extract audio for transcription
    const audio = path.join(WORK_DIR, 'audio.mp3');
    sh(`ffmpeg -y -i "${merged}" -vn -ar 16000 -ac 1 -b:a 64k "${audio}"`);

    // 4. Transcribe via OpenAI Whisper -> SRT
    const srt = path.join(WORK_DIR, 'subs.srt');
    sh(`curl -sS -f https://api.openai.com/v1/audio/transcriptions \
      -H "Authorization: Bearer ${OPENAI_KEY}" \
      -F file=@"${audio}" \
      -F model=whisper-1 \
      -F language=vi \
      -F response_format=srt \
      -o "${srt}"`);
    console.log('--- SRT preview ---');
    console.log(fs.readFileSync(srt, 'utf8').slice(0, 500));
    console.log('-------------------');

    // 5. Burn subtitles into video
    const final = path.join(WORK_DIR, 'final.mp4');
    const style = "FontName=Arial,FontSize=14,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=40";
    sh(`ffmpeg -y -i "${merged}" -vf "subtitles=${srt}:force_style='${style}'" -c:a copy "${final}"`);

    // 6. Upload to litterbox.catbox.moe (24h public temp host)
    const uploadOut = shCapture(
      `curl -sS -f -F "reqtype=fileupload" -F "time=24h" -F "fileToUpload=@${final}" https://litterbox.catbox.moe/resources/internals/api.php`
    );
    if (!uploadOut.startsWith('http')) {
      throw new Error('Upload to litterbox failed: ' + uploadOut);
    }
    const finalUrl = uploadOut;
    console.log('Uploaded ->', finalUrl);

    // 7. Callback to n8n with success
    await postCallback({
      video_id: VIDEO_ID,
      final_url: finalUrl,
      scene_count: sceneUrls.length,
      status: 'success'
    });
    console.log('All done');
  } catch (err) {
    console.error('FATAL:', err);
    try {
      await postCallback({
        video_id: VIDEO_ID,
        status: 'error',
        error: String(err.message || err).slice(0, 500)
      });
    } catch {}
    process.exit(1);
  }
})();
