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
    sh(`ffmpeg -y -f concat -safe 0 -i "${concatList}" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k "${merged}"`);

    // 3. Extract audio for transcription (copy codec preserves exact timing → subtitle sync)
    const audio = path.join(WORK_DIR, 'audio.m4a');
    sh(`ffmpeg -y -i "${merged}" -vn -c:a copy "${audio}"`);

    // 4. Transcribe via OpenAI Whisper -> word-level JSON
    const audioBuf = fs.readFileSync(audio);
    const fd = new FormData();
    fd.append('file', new Blob([audioBuf], { type: 'audio/mp4' }), 'audio.m4a');
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

    // Build ASS with karaoke-style word-by-word highlight (yellow on current word)
    const WORDS_PER_CUE = 3;
    const COLOR_HIGHLIGHT = '&H0000FFFF&'; // vàng — ASS dùng &HBBGGRR
    const COLOR_DEFAULT = '&H00FFFFFF&';   // trắng

    const fmtAssTime = (s) => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.floor(s % 60);
      const cs = Math.round((s - Math.floor(s)) * 100);
      return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    };

    const dialogues = [];
    for (let i = 0; i < words.length; i += WORDS_PER_CUE) {
      const chunk = words.slice(i, i + WORDS_PER_CUE);
      const chunkEnd = chunk[chunk.length - 1].end;
      for (let j = 0; j < chunk.length; j++) {
        const wStart = chunk[j].start;
        const wEnd = j === chunk.length - 1 ? chunkEnd : chunk[j + 1].start;
        const text = chunk.map((w, k) => {
          const up = String(w.word).trim().toUpperCase();
          return k === j
            ? `{\\1c${COLOR_HIGHLIGHT}}${up}{\\1c${COLOR_DEFAULT}}`
            : up;
        }).join(' ');
        dialogues.push(`Dialogue: 0,${fmtAssTime(wStart)},${fmtAssTime(wEnd)},Default,,0,0,0,,${text}`);
      }
    }

    const assContent = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,50,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,2,20,20,280,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogues.join('\n')}
`;
    const ass = path.join(WORK_DIR, 'subs.ass');
    fs.writeFileSync(ass, assContent);
    console.log('--- ASS preview ---');
    console.log(assContent.slice(0, 1000));
    console.log('-------------------');

    // 5. Burn subtitles into video
    const final = path.join(WORK_DIR, 'final.mp4');
    sh(`ffmpeg -y -i "${merged}" -vf "ass=${ass}" -preset ultrafast -crf 23 -c:a copy "${final}"`);

    // 6. Upload to public temp host with retry (catbox primary, litterbox fallback)
    const uploadHosts = [
      { name: 'catbox', cmd: `curl -sS --max-time 90 -F "reqtype=fileupload" -F "fileToUpload=@${final}" https://catbox.moe/user/api.php` },
      { name: 'litterbox', cmd: `curl -sS --max-time 90 -F "reqtype=fileupload" -F "time=24h" -F "fileToUpload=@${final}" https://litterbox.catbox.moe/resources/internals/api.php` },
    ];
    let finalUrl = null;
    let lastErr = null;
    for (const host of uploadHosts) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`Upload to ${host.name} attempt ${attempt}...`);
          const out = shCapture(host.cmd);
          if (out && /^https?:\/\//.test(out.trim())) {
            finalUrl = out.trim();
            console.log(`Uploaded to ${host.name}:`, finalUrl);
            break;
          }
          lastErr = `${host.name} returned non-URL: ${out.slice(0, 200)}`;
          console.log(`Bad response: ${lastErr}`);
        } catch (e) {
          lastErr = `${host.name} attempt ${attempt} failed: ${e.message}`;
          console.log(lastErr);
        }
        if (!finalUrl && attempt < 2) await new Promise(r => setTimeout(r, 3000));
      }
      if (finalUrl) break;
    }
    if (!finalUrl) {
      throw new Error('All upload hosts failed. Last error: ' + lastErr);
    }

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
