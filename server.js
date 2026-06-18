/**
 * ============================================================
 * server.js — Cloud Run: Vídeo de Apresentação do Imóvel
 * Novoimovel.AI — versão compatível com ffmpeg-static
 * ============================================================
 *
 * Endpoint: POST /render-video
 * Retorno:  { success, videoBase64, filename, sizeMB, tempoTotal }
 *
 * Estrutura esperada:
 *   /app/server.js
 *   /app/music/premium.mp3
 *   /app/music/moderno.mp3
 *   /app/music/emocional.mp3
 *
 * package.json (dependências necessárias):
 *   "express": "^4.18.2"
 *   "ffmpeg-static": "^5.2.0"
 * ============================================================
 */

'use strict';

const express      = require('express');
const { spawnSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const https        = require('https');
const http         = require('http');
const crypto       = require('crypto');

// ── ffmpeg-static ─────────────────────────────────────────────
const ffmpegPath = require('ffmpeg-static');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '200mb' }));

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function ts()  { return `[${new Date().toISOString()}]`; }
function uid() { return crypto.randomBytes(6).toString('hex'); }

/** Extrai a parte útil do stderr do FFmpeg (ignora o header de versão). */
function extractStderr(stderr) {
  if (!stderr) return 'sem stderr';
  // Pega os últimos 1200 chars — onde está o erro real
  return stderr.slice(-1200) || stderr.slice(0, 1200) || 'sem stderr';
}

/** Download de arquivo via URL para caminho local. Suporta URLs http/https e data URIs base64. Retorna true/false. */
function downloadFile(url, destPath) {
  // Suporte a data URI (base64)
  if (url.startsWith('data:')) {
    try {
      const commaIdx = url.indexOf(',');
      if (commaIdx === -1) return Promise.resolve(false);
      const b64  = url.slice(commaIdx + 1);
      const buf  = Buffer.from(b64, 'base64');
      fs.writeFileSync(destPath, buf);
      return Promise.resolve(true);
    } catch (e) {
      console.error(`[downloadFile] Erro ao decodificar base64: ${e.message}`);
      return Promise.resolve(false);
    }
  }

  return new Promise((resolve) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        resolve(false);
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(true); });
    }).on('error', () => { file.close(); fs.unlink(destPath, () => {}); resolve(false); });
  });
}

/** Remove arquivos temporários silenciosamente. */
function cleanup(...paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

/** Escapa texto para uso em drawtext do FFmpeg. */
function ffEscape(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\u2019')  // apóstrofo tipográfico
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/** Executa ffmpeg com spawnSync usando o binário do ffmpeg-static. */
function runFFmpeg(args, maxBufferMB = 300) {
  return spawnSync(ffmpegPath, args, {
    encoding: 'utf8',
    maxBuffer: maxBufferMB * 1024 * 1024,
  });
}

// ─────────────────────────────────────────────────────────────
// Normalização de parâmetros do frontend
// ─────────────────────────────────────────────────────────────

/**
 * Normaliza transition para os valores internos:
 * 'corte' → 'cut' | outros: mantém
 */
function normalizeTransition(val) {
  if (!val) return 'dissolve';
  const v = String(val).toLowerCase().trim();
  if (v === 'corte') return 'cut';
  if (['dissolve', 'slide', 'zoom', 'cut'].includes(v)) return v;
  return 'dissolve';
}

/**
 * Normaliza cameraMotion para os valores internos (sem hífens):
 * 'zoom-in' → 'zoomin' | 'pan-left' → 'panleft' | etc.
 */
function normalizeCameraMotion(val) {
  if (!val) return 'auto';
  const v = String(val).toLowerCase().trim().replace(/-/g, '');
  const valid = ['auto', 'zoomin', 'zoomout', 'panleft', 'panup'];
  return valid.includes(v) ? v : 'auto';
}

/**
 * Normaliza music:
 * 'sem_trilha' ou 'sem-trilha' → 'sem-trilha'
 */
function normalizeMusic(val) {
  if (!val) return 'sem-trilha';
  const v = String(val).toLowerCase().trim();
  if (v === 'sem_trilha' || v === 'sem-trilha') return 'sem-trilha';
  if (['premium', 'moderno', 'emocional'].includes(v)) return v;
  return 'sem-trilha';
}

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────

const RESOLUTIONS = {
  '9:16': { w: 720,  h: 1280 },
  '16:9': { w: 1280, h: 720  },
};

const PHOTO_DURATION = 2.8;   // segundos por foto
const END_CARD_DUR   = 2.5;   // duração da tela final
const FADE_DUR       = 0.45;  // duração do xfade entre fotos
const FPS            = 25;

const MUSIC_FILES = {
  premium:   path.join(__dirname, 'music', 'premium.mp3'),
  moderno:   path.join(__dirname, 'music', 'moderno.mp3'),
  emocional: path.join(__dirname, 'music', 'emocional.mp3'),
};

// ─────────────────────────────────────────────────────────────
// Cálculo de duração (sem ffprobe)
// ─────────────────────────────────────────────────────────────

/**
 * Calcula duração aproximada do vídeo final sem usar ffprobe.
 * Para xfade progressivo, cada junção reduz FADE_DUR do total.
 */
function calcVideoDuration(numPhotos, hasEndCard, transition) {
  const photoTotal = numPhotos * PHOTO_DURATION;
  const xfadeCount = transition === 'cut' ? 0 : Math.max(0, numPhotos - 1);
  const xfadeLoss  = xfadeCount * FADE_DUR;
  const endCard    = hasEndCard ? END_CARD_DUR : 0;
  return Math.max(1, photoTotal - xfadeLoss + endCard);
}

// ─────────────────────────────────────────────────────────────
// Ken Burns por foto
// ─────────────────────────────────────────────────────────────

function buildKenBurnsVF(index, w, h, cameraMotion) {
  const frames    = Math.round(PHOTO_DURATION * FPS);
  const zoomStart = 1.00;
  const zoomEnd   = 1.08;
  const step      = ((zoomEnd - zoomStart) / frames).toFixed(7);

  const autoStyles = ['zoomin', 'zoomout', 'panleft', 'panup'];
  const motion     = cameraMotion === 'auto' ? autoStyles[index % 4] : cameraMotion;

  let zoomExpr, xExpr, yExpr;

  switch (motion) {
    case 'zoomin':
      zoomExpr = `zoom+'${step}'`;
      xExpr    = `iw/2-(iw/zoom/2)`;
      yExpr    = `ih/2-(ih/zoom/2)`;
      break;
    case 'zoomout':
      zoomExpr = `if(eq(on\\,1)\\,${zoomEnd}\\,zoom-${step})`;
      xExpr    = `iw/2-(iw/zoom/2)`;
      yExpr    = `ih/2-(ih/zoom/2)`;
      break;
    case 'panleft':
      zoomExpr = `${(zoomStart + 0.04).toFixed(4)}`;
      xExpr    = `(iw/zoom/2)*on/${frames}`;
      yExpr    = `ih/2-(ih/zoom/2)`;
      break;
    case 'panup':
      zoomExpr = `${(zoomStart + 0.04).toFixed(4)}`;
      xExpr    = `iw/2-(iw/zoom/2)`;
      yExpr    = `(ih/zoom/2)*on/${frames}`;
      break;
    default:
      zoomExpr = `zoom+'${step}'`;
      xExpr    = `iw/2-(iw/zoom/2)`;
      yExpr    = `ih/2-(ih/zoom/2)`;
  }

  return [
    `scale=${w * 2}:${h * 2},setsar=1`,
    `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${frames}:s=${w}x${h}:fps=${FPS}`,
    `setpts=PTS-STARTPTS`,
    `fps=${FPS}`,
  ].join(',');
}

// ─────────────────────────────────────────────────────────────
// Overlay do corretor (rodapé)
// ─────────────────────────────────────────────────────────────

function buildBrokerFilters(brokerName, brokerPhone, companyName, creci, h) {
  const lines = [];
  if (brokerName)  lines.push({ text: brokerName,  size: 22 });
  if (companyName) lines.push({ text: companyName, size: 17 });

  const subLine = [brokerPhone, creci].filter(Boolean).join('  ·  ');
  if (subLine)     lines.push({ text: subLine,     size: 16 });

  if (!lines.length) return [];

  const lineH  = 30;
  const padV   = 14;
  const totalH = lines.length * lineH + padV * 2;
  const yStart = h - totalH - 8;

  const filters = [];
  filters.push(`drawbox=x=0:y=${yStart}:w=iw:h=${totalH}:color=black@0.55:t=fill`);

  lines.forEach((line, i) => {
    const yPos = yStart + padV + i * lineH;
    filters.push(
      `drawtext=text='${ffEscape(line.text)}':` +
      `fontsize=${line.size}:fontcolor=white:` +
      `shadowcolor=black@0.9:shadowx=1:shadowy=1:` +
      `x=(w-text_w)/2:y=${yPos}`
    );
  });

  return filters;
}

// ─────────────────────────────────────────────────────────────
// Tela final (end card)
// ─────────────────────────────────────────────────────────────

function generateEndCard(w, h, brokerName, brokerPhone, companyName, creci, jobId) {
  const outPath = `/tmp/endcard_${jobId}.mp4`;

  const lines = [];
  lines.push({ text: 'Agende uma visita', size: 38, color: 'FFD700' });
  if (brokerName)  lines.push({ text: brokerName,  size: 24, color: 'FFFFFF' });
  if (brokerPhone) lines.push({ text: brokerPhone, size: 20, color: 'DDDDDD' });
  if (companyName) lines.push({ text: companyName, size: 18, color: 'BBBBBB' });
  if (creci)       lines.push({ text: creci,        size: 16, color: 'AAAAAA' });

  const lineH  = 44;
  const totalH = lines.length * lineH;

  const textFilters = lines.map((line, i) => {
    const yPos = `(h-${totalH})/2+${i * lineH}`;
    return (
      `drawtext=text='${ffEscape(line.text)}':` +
      `fontsize=${line.size}:fontcolor=${line.color}:` +
      `shadowcolor=black@0.9:shadowx=2:shadowy=2:` +
      `x=(w-text_w)/2:y=${yPos}`
    );
  });

  const vf = [
    `fade=t=in:st=0:d=0.5`,
    `fade=t=out:st=${(END_CARD_DUR - 0.5).toFixed(2)}:d=0.5`,
    ...textFilters,
  ].join(',');

  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=0x111827:size=${w}x${h}:rate=${FPS}:duration=${END_CARD_DUR}`,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-pix_fmt', 'yuv420p',
    '-an',
    outPath,
  ];

  console.log(`${ts()} [EndCard] Gerando tela final (${lines.length} linhas)...`);
  const result = runFFmpeg(args, 100);

  if (result.status !== 0) {
    const stderrReal = extractStderr(result.stderr);
    console.error(`${ts()} [EndCard] ERRO: ${stderrReal}`);
    return null;
  }
  console.log(`${ts()} [EndCard] ✓ Tela final gerada`);
  return outPath;
}

// ─────────────────────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────────────────────

/** Rota raiz — teste de status no navegador */
app.get('/', (req, res) => {
  res.json({
    success: true,
    status:  'online',
    message: 'Novoimovel.AI Video Renderer Online',
    version: 'v2-transitions-kenburns-broker-endcard',
    ffmpeg:  ffmpegPath ? 'available' : 'not_found',
  });
});

/** Health check */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────
// ENDPOINT PRINCIPAL
// ─────────────────────────────────────────────────────────────

app.post('/render-video', async (req, res) => {
  const t0       = Date.now();
  const jobId    = uid();
  const tmpFiles = [];

  console.log(`\n${ts()} ========== /render-video JOB ${jobId} ==========`);

  try {
    // ── 1. Parse e normalização do payload ──────────────────────────
    const {
      pedidoId,
      userEmail,
      images,
      format       = '9:16',
      logoUrl,
      brokerName,
      brokerPhone,
      companyName,
      creci,
    } = req.body;

    const music        = normalizeMusic(req.body.music);
    const transition   = normalizeTransition(req.body.transition);
    const cameraMotion = normalizeCameraMotion(req.body.cameraMotion);

    if (!Array.isArray(images) || images.length < 5) {
      return res.status(400).json({
        success: false,
        error: 'Envie pelo menos 5 imagens para gerar o vídeo.',
      });
    }

    if (images.length > 12) {
      return res.status(400).json({
        success: false,
        error: 'Envie no máximo 12 imagens para gerar o vídeo.',
      });
    }

    const { w, h } = RESOLUTIONS[format] || RESOLUTIONS['9:16'];

    // ── Logs de entrada ──────────────────────────────────────────────
    console.log(`${ts()} [${jobId}] pedidoId:     ${pedidoId || 'n/a'}`);
    console.log(`${ts()} [${jobId}] userEmail:    ${userEmail || 'n/a'}`);
    console.log(`${ts()} [${jobId}] images:       ${images.length} fotos`);
    console.log(`${ts()} [${jobId}] format:       ${format} → ${w}x${h}`);
    console.log(`${ts()} [${jobId}] music:        ${music} (raw: ${req.body.music})`);
    console.log(`${ts()} [${jobId}] transition:   ${transition} (raw: ${req.body.transition})`);
    console.log(`${ts()} [${jobId}] cameraMotion: ${cameraMotion} (raw: ${req.body.cameraMotion})`);
    console.log(`${ts()} [${jobId}] corretor:     ${brokerName ? `${brokerName} | ${brokerPhone || '-'} | ${companyName || '-'} | ${creci || '-'}` : 'não informado'}`);
    console.log(`${ts()} [${jobId}] logo:         ${logoUrl ? 'sim' : 'não'}`);
    console.log(`${ts()} [${jobId}] ffmpegPath:   ${ffmpegPath}`);

    // ── 2. Download das imagens ──────────────────────────────────────
    console.log(`${ts()} [${jobId}] Baixando ${images.length} imagens...`);
    const imgPaths = [];
    for (let i = 0; i < images.length; i++) {
      const imgPath = `/tmp/img_${jobId}_${i}.jpg`;
      const ok = await downloadFile(images[i], imgPath);
      if (!ok) throw new Error(`Falha ao baixar imagem ${i + 1}: ${images[i].slice(0, 80)}`);
      imgPaths.push(imgPath);
      tmpFiles.push(imgPath);
    }
    console.log(`${ts()} [${jobId}] ✓ ${imgPaths.length} imagens baixadas`);

    // ── 3. Download da logo (não-fatal) ──────────────────────────────
    let logoPath = null;
    if (logoUrl) {
      const lp = `/tmp/logo_${jobId}.png`;
      const ok = await downloadFile(logoUrl, lp);
      if (ok) {
        logoPath = lp;
        tmpFiles.push(lp);
        console.log(`${ts()} [${jobId}] ✓ Logo baixada`);
      } else {
        console.warn(`${ts()} [${jobId}] ⚠ Falha ao baixar logo — continuando sem ela`);
      }
    }

    // ── 4. Gerar segmentos Ken Burns por foto ─────────────────────────
    console.log(`${ts()} [${jobId}] Gerando ${imgPaths.length} segmentos Ken Burns...`);
    const segmentPaths = [];
    const hasCorretor  = !!(brokerName || brokerPhone || companyName || creci);
    const autoStyles   = ['zoomin', 'zoomout', 'panleft', 'panup'];

    for (let i = 0; i < imgPaths.length; i++) {
      const segPath = `/tmp/seg_${jobId}_${i}.mp4`;
      tmpFiles.push(segPath);

      let vfParts = buildKenBurnsVF(i, w, h, cameraMotion);

      if (hasCorretor) {
        const brokerFilters = buildBrokerFilters(brokerName, brokerPhone, companyName, creci, h);
        if (brokerFilters.length) {
          vfParts += ',' + brokerFilters.join(',');
        }
      }

      // Watermark de versão — remover após validação
      vfParts += `,drawtext=text='V2':fontsize=28:fontcolor=white@0.8:shadowcolor=black@0.9:shadowx=1:shadowy=1:x=12:y=12`;

      const ffInputs = ['-loop', '1', '-t', String(PHOTO_DURATION), '-i', imgPaths[i]];
      let   vfFinal  = vfParts;

      if (logoPath) {
        const logoW = Math.round(w * 0.18);
        const logoX = w - logoW - 16;
        const logoY = 20;
        ffInputs.push('-i', logoPath);
        vfFinal = `${vfFinal}[base${i}];[base${i}][1:v]scale=${logoW}:-1[logo${i}];[base${i}][logo${i}]overlay=${logoX}:${logoY}`;
      }

      const motion = cameraMotion === 'auto' ? autoStyles[i % 4] : cameraMotion;
      console.log(`${ts()} [${jobId}] Seg ${i + 1}/${imgPaths.length} | motion=${motion}`);

      const args = [
        '-y',
        ...ffInputs,
        '-vf', vfFinal,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-pix_fmt', 'yuv420p',
        '-an',
        segPath,
      ];

      const result = runFFmpeg(args, 150);
      if (result.status !== 0) {
        const stderrReal = extractStderr(result.stderr);
        console.error(`${ts()} [${jobId}] FFmpeg seg ${i} STDERR:\n${stderrReal}`);
        throw new Error(`Erro ao processar imagem ${i + 1}: ${stderrReal}`);
      }
      segmentPaths.push(segPath);
    }
    console.log(`${ts()} [${jobId}] ✓ Todos os segmentos gerados`);

    // ── 5. Concatenar com transições ─────────────────────────────────
    console.log(`${ts()} [${jobId}] Montando vídeo com transição "${transition}"...`);
    let mainVideoPath;

    if (transition === 'cut' || segmentPaths.length === 1) {
      const listPath = `/tmp/concatlist_${jobId}.txt`;
      tmpFiles.push(listPath);
      fs.writeFileSync(listPath, segmentPaths.map(p => `file '${p}'`).join('\n'));

      mainVideoPath = `/tmp/main_${jobId}.mp4`;
      tmpFiles.push(mainVideoPath);

      const args = [
        '-y',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-pix_fmt', 'yuv420p',
        '-an',
        mainVideoPath,
      ];
      const result = runFFmpeg(args, 300);
      if (result.status !== 0) {
        const stderrReal = extractStderr(result.stderr);
        throw new Error(`Erro na concatenação: ${stderrReal}`);
      }

    } else {
      const xfadeType =
        transition === 'slide' ? 'slideleft' :
        transition === 'zoom'  ? 'zoomin'    :
        'dissolve';

      let currentPath = segmentPaths[0];

      for (let i = 1; i < segmentPaths.length; i++) {
        const xfadeOut = `/tmp/xf_${jobId}_${i}.mp4`;
        tmpFiles.push(xfadeOut);
        const offset = (PHOTO_DURATION - FADE_DUR).toFixed(3);

        const args = [
          '-y',
          '-i', currentPath,
          '-i', segmentPaths[i],
          '-filter_complex',
          `[0:v][1:v]xfade=transition=${xfadeType}:duration=${FADE_DUR}:offset=${offset}[v]`,
          '-map', '[v]',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
          '-pix_fmt', 'yuv420p',
          '-an',
          xfadeOut,
        ];

        console.log(`${ts()} [${jobId}] xfade ${i}/${segmentPaths.length - 1}`);
        const result = runFFmpeg(args, 300);
        if (result.status !== 0) {
          const stderrReal = extractStderr(result.stderr);
          throw new Error(`Erro no xfade ${i}: ${stderrReal}`);
        }
        currentPath = xfadeOut;
      }
      mainVideoPath = currentPath;
    }
    console.log(`${ts()} [${jobId}] ✓ Vídeo principal montado`);

    // ── 6. Concatenar tela final ──────────────────────────────────────
    let finalVideoPath = mainVideoPath;
    {
      const endCardPath = generateEndCard(w, h, brokerName, brokerPhone, companyName, creci, jobId);
      if (endCardPath) {
        tmpFiles.push(endCardPath);
        const withEnd    = `/tmp/withend_${jobId}.mp4`;
        const concatPath = `/tmp/endcat_${jobId}.txt`;
        tmpFiles.push(withEnd, concatPath);
        fs.writeFileSync(concatPath, `file '${mainVideoPath}'\nfile '${endCardPath}'`);

        const args = [
          '-y',
          '-f', 'concat', '-safe', '0', '-i', concatPath,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
          '-pix_fmt', 'yuv420p',
          '-an',
          withEnd,
        ];
        const result = runFFmpeg(args, 300);
        if (result.status === 0) {
          finalVideoPath = withEnd;
          console.log(`${ts()} [${jobId}] ✓ Tela final concatenada`);
        } else {
          const stderrReal = extractStderr(result.stderr);
          console.warn(`${ts()} [${jobId}] ⚠ Falha ao concatenar tela final — continuando sem ela: ${stderrReal}`);
        }
      }
    }

    // ── 7. Adicionar trilha sonora ────────────────────────────────────
    const outputPath = `/tmp/output_${jobId}.mp4`;
    tmpFiles.push(outputPath);

    const musicFile    = MUSIC_FILES[music];
    const hasMusicFile = musicFile && fs.existsSync(musicFile);

    if (music === 'sem-trilha' || !hasMusicFile) {
      if (music !== 'sem-trilha') {
        console.warn(`${ts()} [${jobId}] ⚠ Trilha não encontrada: ${musicFile} — gerando sem áudio`);
        console.warn(`${ts()} [${jobId}]   → Coloque em: /app/music/${music}.mp3`);
      } else {
        console.log(`${ts()} [${jobId}] Sem trilha sonora`);
      }

      const result = runFFmpeg(['-y', '-i', finalVideoPath, '-c:v', 'copy', '-an', outputPath], 300);
      if (result.status !== 0) {
        const stderrReal = extractStderr(result.stderr);
        throw new Error(`Erro ao finalizar vídeo: ${stderrReal}`);
      }

    } else {
      // Duração calculada sem ffprobe
      const videoDuration = calcVideoDuration(imgPaths.length, true, transition);
      const fadeOutStart  = Math.max(0, videoDuration - 1.5).toFixed(2);

      console.log(`${ts()} [${jobId}] Duração estimada: ${videoDuration.toFixed(2)}s | Trilha: ${music}`);

      const args = [
        '-y',
        '-i', finalVideoPath,
        '-stream_loop', '-1', '-i', musicFile,
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '128k',
        '-af', `volume=0.35,afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeOutStart}:d=1.5`,
        '-t', videoDuration.toFixed(3),
        '-shortest',
        outputPath,
      ];
      console.log(`${ts()} [${jobId}] CMD trilha: ffmpeg ${args.join(' ')}`);
      const result = runFFmpeg(args, 300);

      if (result.status !== 0) {
        const stderrReal = extractStderr(result.stderr);
        console.warn(`${ts()} [${jobId}] ⚠ Erro na trilha — fallback sem áudio: ${stderrReal}`);
        const fallback = runFFmpeg(['-y', '-i', finalVideoPath, '-c:v', 'copy', '-an', outputPath], 300);
        if (fallback.status !== 0) {
          const stderrFallback = extractStderr(fallback.stderr);
          throw new Error(`Erro ao finalizar vídeo: ${stderrFallback}`);
        }
      }
    }

    // ── 8. Ler e retornar base64 ──────────────────────────────────────
    if (!fs.existsSync(outputPath)) throw new Error('Arquivo de saída não foi gerado.');

    const stats      = fs.statSync(outputPath);
    const sizeMB     = (stats.size / (1024 * 1024)).toFixed(2);
    const tempoTotal = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`${ts()} [${jobId}] ✓ Vídeo final: ${sizeMB} MB | ${tempoTotal}s`);

    const videoBase64 = fs.readFileSync(outputPath).toString('base64');
    const filename    = `${pedidoId || jobId}.mp4`;

    console.log(`${ts()} [${jobId}] ========== CONCLUÍDO em ${tempoTotal}s ==========\n`);

    return res.json({ success: true, pedidoId, filename, videoBase64, sizeMB, tempoTotal });

  } catch (err) {
    const errMsg = err?.message || 'Erro desconhecido';
    console.error(`${ts()} ERRO FATAL [${jobId}]: ${errMsg}`);
    return res.status(500).json({
      success: false,
      error:   'Falha ao renderizar o vídeo.',
      detail:  errMsg.slice(0, 1500),
    });

  } finally {
    cleanup(...tmpFiles);
    console.log(`${ts()} [${jobId}] Cleanup: ${tmpFiles.length} arquivo(s) temporário(s) removido(s)`);
  }
});

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`${ts()} Servidor iniciado na porta ${PORT}`);
  console.log(`${ts()} ffmpegPath: ${ffmpegPath || 'NÃO ENCONTRADO'}`);
  for (const [key, p] of Object.entries(MUSIC_FILES)) {
    const exists = fs.existsSync(p);
    console.log(`${ts()} Trilha [${key}]: ${exists ? '✓ encontrada' : `✗ não encontrada — coloque em ${p}`}`);
  }
});
