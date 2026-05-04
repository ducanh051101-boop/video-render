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

    // 4. Transcribe via OpenAI Whisper -> word-level JSON
    const audioBuf = fs.readFileSync(audio);
    const fd = new FormData();
    fd.append('file', new Blob([audioBuf], { type: 'audio/mpeg' }), 'audio.mp3');
    fd.append('model', 'whisper-1');
    fd.append('language', 'vi');
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'word');
    const wRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: fd
    });
    if (!wRes.ok) {
      throw new Error(`Whisper failed ${wRes.status}: ${await wRes.text()}`);
    }
    const wData = await wRes.json();
    const words = wData.words || [];
    console.log(`Whisper: ${words.length} words`);

    // Build SRT with max WORDS_PER_CUE words per line, UPPERCASE for Reels-style
    const WORDS_PER_CUE = 3;
    const fmtTime = (s) => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.floor(s % 60);
      const ms = Math.round((s - Math.floor(s)) * 1000);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    const cues = [];
    for (let i = 0; i < words.length; i += WORDS_PER_CUE) {
      const chunk = words.slice(i, i + WORDS_PER_CUE);
      cues.push({
        start: chunk[0].start,
        end: chunk[chunk.length - 1].end,
        text: chunk.map(w => String(w.word).trim()).join(' ').toUpperCase()
      });
    }
    const srt = path.join(WORK_DIR, 'subs.srt');
    const srtContent = cues
      .map((c, i) => `${i + 1}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text}\n`)
      .join('\n');
    fs.writeFileSync(srt, srtContent);
    console.log('--- SRT preview ---');
    console.log(srtContent.slice(0, 500));
    console.log('-------------------');

    // 5. Burn subtitles into video — Roboto Bold, white with thick black outline
    const final = path.join(WORK_DIR, 'final.mp4');
    const style = "FontName=Roboto,FontSize=22,Bold=-1,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=4,Shadow=0,Alignment=2,MarginV=280";
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
