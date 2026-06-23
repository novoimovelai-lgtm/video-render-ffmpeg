/**
 * ============================================================
 * server.js — Cloud Run: Vídeo de Apresentação do Imóvel
 * Novoimovel.AI — stable-basic-video-v2-redirect-safe
 * ============================================================
 *
 * Versão mínima estável com download robusto (redirects 301-308):
 * - Sem Ken Burns / zoompan
 * - Sem drawtext / watermark / corretor
 * - Sem xfade / transições
 * - Sem tela final
 * - Sem trilha sonora
 * - Sem logo
 *
 * downloadFile aceita:
 *   A) data:image/jpeg;base64,...
 *   B) data:image/png;base64,...
 *   C) URL http
 *   D) URL https
 *   E) redirects 301, 302, 303, 307, 308 (até 5 níveis)
 *
 * Fluxo: fotos → segmentos simples (2.5s cada) → concat → base64
 *
 * Endpoint: POST /render-video
 * Retorno:  { success, videoBase64, filename, sizeMB, tempoTotal }
 *
 * package.json:
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

const ffmpegPath = require('ffmpeg-static');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '200mb' }));

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function ts()  { return `[${new Date().toISOString()}]`; }
function uid() { return crypto.randomBytes(6).toString('hex'); }

function extractStderr(stderr) {
  if (!stderr) return 'sem stderr';
  return stderr.slice(-1200) || stderr.slice(0, 1200) || 'sem stderr';
}

function cleanup(...paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

function runFFmpeg(args, maxBufferMB = 300) {
  return spawnSync(ffmpegPath, args, {
    encoding: 'utf8',
    maxBuffer: maxBufferMB * 1024 * 1024,
  });
}

// ─────────────────────────────────────────────────────────────
// downloadFile — robusto: data URI + redirects 301-308
// ─────────────────────────────────────────────────────────────

/**
 * Baixa uma imagem (data URI ou URL http/https) para destPath.
 * Segue redirects 301, 302, 303, 307, 308 até 5 níveis.
 * Resolve true (sucesso) ou false (falha).
 */
function downloadFile(url, destPath, maxRedirects = 5) {
  // ── Caso A/B: data URI (base64) ──
  if (url.startsWith('data:')) {
    try {
      const commaIdx = url.indexOf(',');
      if (commaIdx === -1) return Promise.resolve(false);
      const b64 = url.slice(commaIdx + 1);
      const buf = Buffer.from(b64, 'base64');
      fs.writeFileSync(destPath, buf);
      console.log(`${ts()} [downloadFile] Data URI salva: ${buf.length} bytes`);
      return Promise.resolve(true);
    } catch (e) {
      console.error(`${ts()} [downloadFile] Erro ao decodificar base64: ${e.message}`);
      return Promise.resolve(false);
    }
  }

  // ── Caso C/D/E: URL http/https com redirects ──
  return new Promise((resolve) => {
    let redirects = 0;
    let finalUrl  = url;

    const doRequest = (reqUrl) => {
      const proto = reqUrl.startsWith('https') ? https : http;

      const req = proto.get(reqUrl, (res) => {
        const status = res.statusCode;

        // ── Redirect ──
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          redirects++;
          res.resume(); // consome o corpo do redirect

          if (redirects > maxRedirects) {
            console.error(`${ts()} [downloadFile] Máximo de ${maxRedirects} redirects excedido (URL inicial: ${url})`);
            return resolve(false);
          }

          let location = res.headers.location;

          // URL relativa → absoluta
          try {
            if (location.startsWith('/')) {
              const parsed = new URL(reqUrl);
              location = `${parsed.protocol}//${parsed.host}${location}`;
            } else if (!location.startsWith('http')) {
              const parsed = new URL(reqUrl);
              location = new URL(location, `${parsed.protocol}//${parsed.host}`).href;
            }
          } catch (e) {
            console.error(`${ts()} [downloadFile] Erro ao resolver redirect: ${e.message}`);
            return resolve(false);
          }

          console.log(`${ts()} [downloadFile] Redirect ${redirects}/${maxRedirects}: ${status} → ${location}`);
          finalUrl = location;
          return doRequest(location);
        }

        // ── Status não-200 e não-redirect = erro real ──
        if (status !== 200) {
          console.error(`${ts()} [downloadFile] HTTP ${status} (URL final: ${reqUrl})`);
          res.resume();
          return resolve(false);
        }

        // ── Sucesso: salvar arquivo ──
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          const sizeBytes = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
          console.log(`${ts()} [downloadFile] ✓ Baixado: ${sizeBytes} bytes | URL final: ${finalUrl}`);
          resolve(true);
        });
        file.on('error', () => {
          fs.unlink(destPath, () => {});
          resolve(false);
        });
      });

      req.on('error', (e) => {
        console.error(`${ts()} [downloadFile] Erro de rede: ${e.message} (URL: ${reqUrl})`);
        resolve(false);
      });
    };

    doRequest(url);
  });
}

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────

const VERSION = 'stable-basic-video-v2-redirect-safe';

const RESOLUTIONS = {
  '9:16': { w: 720,  h: 1280 },
  '16:9': { w: 1280, h: 720  },
};

const PHOTO_DURATION = 2.5;  // segundos por foto
const FPS            = 25;

// ─────────────────────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    success: true,
    status:  'online',
    message: 'Novoimovel.AI Video Renderer Online',
    version: VERSION,
    ffmpeg:  ffmpegPath ? 'available' : 'not_found',
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: VERSION, timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────
// ENDPOINT PRINCIPAL
// ─────────────────────────────────────────────────────────────

app.post('/render-video', async (req, res) => {
  const t0       = Date.now();
  const jobId    = uid();
  const tmpFiles = [];

  console.log(`\n${ts()} ========== /render-video JOB ${jobId} ==========`);
  console.log(`${ts()} [${jobId}] version: ${VERSION}`);

  try {
    // ── 1. Parse do payload ───────────────────────────────────────────
    const {
      pedidoId,
      userEmail,
      images,
      format = '9:16',
      music,
    } = req.body;

    // ── 2. Validações ─────────────────────────────────────────────────
    if (!Array.isArray(images) || images.length < 5) {
      console.error(`${ts()} [${jobId}] ERRO: menos de 5 imagens (${Array.isArray(images) ? images.length : 0})`);
      return res.status(400).json({
        success: false,
        error: 'Envie pelo menos 5 imagens para gerar o vídeo.',
      });
    }
    if (images.length > 12) {
      console.error(`${ts()} [${jobId}] ERRO: mais de 12 imagens (${images.length})`);
      return res.status(400).json({
        success: false,
        error: 'Envie no máximo 12 imagens para gerar o vídeo.',
      });
    }

    const { w, h } = RESOLUTIONS[format] || RESOLUTIONS['9:16'];

    // ── Logs de entrada ──────────────────────────────────────────────
    console.log(`${ts()} [${jobId}] pedidoId:   ${pedidoId || 'n/a'}`);
    console.log(`${ts()} [${jobId}] userEmail:  ${userEmail || 'n/a'}`);
    console.log(`${ts()} [${jobId}] fotos:      ${images.length}`);
    console.log(`${ts()} [${jobId}] formato:    ${format} → ${w}x${h}`);
    console.log(`${ts()} [${jobId}] music:      ${music || 'sem-trilha'}`);
    console.log(`${ts()} [${jobId}] ffmpegPath: ${ffmpegPath}`);

    // ── 3. Download/salvar imagens ───────────────────────────────────
    console.log(`${ts()} [${jobId}] Baixando ${images.length} imagens...`);
    const imgPaths = [];

    for (let i = 0; i < images.length; i++) {
      const imgPath = `/tmp/img_${jobId}_${i}.jpg`;
      const isDataUri = images[i].startsWith('data:');
      const imgType = isDataUri ? 'base64' : 'URL';
      console.log(`${ts()} [${jobId}] Imagem ${i + 1}/${images.length} | tipo: ${imgType}`);

      const ok = await downloadFile(images[i], imgPath);
      if (!ok) {
        console.error(`${ts()} [${jobId}] ✗ Falha ao baixar imagem ${i + 1}`);
        return res.status(500).json({
          success: false,
          error: `Falha ao baixar imagem ${i + 1}.`,
          detail: `Tipo: ${imgType} | URL: ${images[i].slice(0, 120)}`,
        });
      }

      imgPaths.push(imgPath);
      tmpFiles.push(imgPath);
    }
    console.log(`${ts()} [${jobId}] ✓ Todas as ${imgPaths.length} imagens baixadas`);

    // ── 4. Gerar segmentos simples (sem zoompan, drawtext, logo) ──────
    console.log(`${ts()} [${jobId}] Gerando ${imgPaths.length} segmentos (${PHOTO_DURATION}s cada)...`);
    const segmentPaths = [];

    for (let i = 0; i < imgPaths.length; i++) {
      const segPath = `/tmp/seg_${jobId}_${i}.mp4`;
      tmpFiles.push(segPath);

      // scale com crop para preencher o formato sem distorcer
      const vf = [
        `scale=${w}:${h}:force_original_aspect_ratio=increase`,
        `crop=${w}:${h}`,
        `fps=${FPS}`,
        `format=yuv420p`,
      ].join(',');

      const args = [
        '-y',
        '-loop', '1',
        '-t', String(PHOTO_DURATION),
        '-i', imgPaths[i],
        '-vf', vf,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '28',
        '-pix_fmt', 'yuv420p',
        '-an',
        segPath,
      ];

      console.log(`${ts()} [${jobId}] Seg ${i + 1}/${imgPaths.length} processando...`);
      const result = runFFmpeg(args, 150);

      if (result.status !== 0) {
        const stderrReal = extractStderr(result.stderr);
        console.error(`${ts()} [${jobId}] FFmpeg seg ${i + 1} STDERR:\n${stderrReal}`);
        throw new Error(`Erro ao processar imagem ${i + 1}: ${stderrReal}`);
      }

      console.log(`${ts()} [${jobId}] ✓ Seg ${i + 1} gerado`);
      segmentPaths.push(segPath);
    }
    console.log(`${ts()} [${jobId}] ✓ Todos os ${segmentPaths.length} segmentos gerados`);

    // ── 5. Concatenar (concat demuxer — sem xfade) ────────────────────
    console.log(`${ts()} [${jobId}] Concatenando segmentos...`);

    const listPath   = `/tmp/concatlist_${jobId}.txt`;
    const outputPath = `/tmp/output_${jobId}.mp4`;
    tmpFiles.push(listPath, outputPath);

    fs.writeFileSync(listPath, segmentPaths.map(p => `file '${p}'`).join('\n'));

    const concatArgs = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-an',
      outputPath,
    ];

    const concatResult = runFFmpeg(concatArgs, 300);
    if (concatResult.status !== 0) {
      const stderrReal = extractStderr(concatResult.stderr);
      console.error(`${ts()} [${jobId}] Concat STDERR:\n${stderrReal}`);
      throw new Error(`Erro na concatenação: ${stderrReal}`);
    }
    console.log(`${ts()} [${jobId}] ✓ Concatenação concluída`);

    // ── 6. Verificar e retornar base64 ───────────────────────────────
    if (!fs.existsSync(outputPath)) {
      throw new Error('Arquivo de saída não foi gerado.');
    }

    const stats      = fs.statSync(outputPath);
    const sizeMB     = (stats.size / (1024 * 1024)).toFixed(2);
    const tempoTotal = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`${ts()} [${jobId}] ✓ Vídeo final: ${sizeMB} MB | ${tempoTotal}s`);
    console.log(`${ts()} [${jobId}] ========== CONCLUÍDO em ${tempoTotal}s ==========\n`);

    const videoBase64 = fs.readFileSync(outputPath).toString('base64');
    const filename    = `${pedidoId || jobId}.mp4`;

    return res.json({
      success:    true,
      pedidoId,
      filename,
      videoBase64,
      sizeMB,
      tempoTotal,
    });

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
    console.log(`${ts()} [${jobId}] Cleanup: ${tmpFiles.length} arquivo(s) removido(s)`);
  }
});

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`${ts()} Servidor iniciado na porta ${PORT}`);
  console.log(`${ts()} version: ${VERSION}`);
  console.log(`${ts()} ffmpegPath: ${ffmpegPath || 'NÃO ENCONTRADO'}`);
});
