/**
 * ============================================================
 * server.js — Cloud Run: Vídeo de Apresentação do Imóvel
 * Novoimovel.AI — stable-basic-video-v1
 * ============================================================
 *
 * Versão mínima estável:
 * - Sem Ken Burns / zoompan
 * - Sem drawtext / watermark / corretor durante fotos
 * - Sem xfade / transições complexas
 * - Sem tela final
 * - Sem trilha sonora
 * - Sem logo
 *
 * Fluxo: fotos → segmentos simples → concat → base64
 *
 * Endpoint: POST /render-video
 * Retorno:  { success, videoBase64, filename, sizeMB, tempoTotal }
 *
 * Estrutura esperada:
 *   /app/server.js
 *
 * package.json (dependências necessárias):
 *   "express": "^4.18.2"
 *   "ffmpeg-static": "^5.2.0"
 * ============================================================
 */

'use strict';

const express       = require('express');
const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');
const crypto        = require('crypto');

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

/** Extrai a parte útil do stderr do FFmpeg (últimos 1200 chars onde fica o erro real). */
function extractStderr(stderr) {
  if (!stderr) return 'sem stderr';
  return stderr.slice(-1200) || stderr.slice(0, 1200) || 'sem stderr';
}

/** Salva data URI base64 em arquivo local. Retorna true/false. */
function saveDataUri(dataUri, destPath) {
  try {
    const commaIdx = dataUri.indexOf(',');
    if (commaIdx === -1) return false;
    const b64 = dataUri.slice(commaIdx + 1);
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(destPath, buf);
    return true;
  } catch (e) {
    console.error(`[saveDataUri] Erro: ${e.message}`);
    return false;
  }
}

/** Remove arquivos temporários silenciosamente. */
function cleanup(...paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

/** Executa ffmpeg com spawnSync. */
function runFFmpeg(args, maxBufferMB = 300) {
  return spawnSync(ffmpegPath, args, {
    encoding: 'utf8',
    maxBuffer: maxBufferMB * 1024 * 1024,
  });
}

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────

const RESOLUTIONS = {
  '9:16': { w: 720,  h: 1280 },
  '16:9': { w: 1280, h: 720  },
};

const PHOTO_DURATION = 2.8;  // segundos por foto
const FPS            = 25;

// ─────────────────────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────────────────────

/** Rota raiz — teste de status */
app.get('/', (req, res) => {
  res.json({
    success: true,
    status:  'online',
    message: 'Novoimovel.AI Video Renderer Online',
    version: 'stable-basic-video-v1',
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
    // ── 1. Parse do payload ──────────────────────────────────────────
    const {
      pedidoId,
      userEmail,
      images,
      format = '9:16',
    } = req.body;

    // ── 2. Validações básicas ────────────────────────────────────────
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
    console.log(`${ts()} [${jobId}] pedidoId:   ${pedidoId || 'n/a'}`);
    console.log(`${ts()} [${jobId}] userEmail:  ${userEmail || 'n/a'}`);
    console.log(`${ts()} [${jobId}] images:     ${images.length} fotos`);
    console.log(`${ts()} [${jobId}] format:     ${format} → ${w}x${h}`);
    console.log(`${ts()} [${jobId}] ffmpegPath: ${ffmpegPath}`);

    // ── 3. Salvar imagens em disco ───────────────────────────────────
    console.log(`${ts()} [${jobId}] Salvando ${images.length} imagens...`);
    const imgPaths = [];

    for (let i = 0; i < images.length; i++) {
      const imgPath = `/tmp/img_${jobId}_${i}.jpg`;

      const isDataUri = images[i].startsWith('data:');
      if (isDataUri) {
        const ok = saveDataUri(images[i], imgPath);
        if (!ok) throw new Error(`Falha ao salvar imagem ${i + 1} (data URI).`);
      } else {
        // URL pública — baixar via https/http
        const proto = images[i].startsWith('https') ? require('https') : require('http');
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(imgPath);
          proto.get(images[i], (r) => {
            if (r.statusCode !== 200) {
              file.close();
              fs.unlink(imgPath, () => {});
              return reject(new Error(`HTTP ${r.statusCode} ao baixar imagem ${i + 1}`));
            }
            r.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
          }).on('error', reject);
        });
      }

      imgPaths.push(imgPath);
      tmpFiles.push(imgPath);
      console.log(`${ts()} [${jobId}] Imagem ${i + 1}/${images.length} salva`);
    }
    console.log(`${ts()} [${jobId}] ✓ Todas as imagens salvas`);

    // ── 4. Gerar segmentos simples por foto ──────────────────────────
    console.log(`${ts()} [${jobId}] Gerando ${imgPaths.length} segmentos...`);
    const segmentPaths = [];

    for (let i = 0; i < imgPaths.length; i++) {
      const segPath = `/tmp/seg_${jobId}_${i}.mp4`;
      tmpFiles.push(segPath);

      // Filtro simples: scale com crop para cobrir o formato sem distorcer
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

      console.log(`${ts()} [${jobId}] Seg ${i + 1}/${imgPaths.length} — ffmpeg iniciando`);
      const result = runFFmpeg(args, 150);

      if (result.status !== 0) {
        const stderrReal = extractStderr(result.stderr);
        console.error(`${ts()} [${jobId}] FFmpeg seg ${i} STDERR:\n${stderrReal}`);
        throw new Error(`Erro ao processar imagem ${i + 1}: ${stderrReal}`);
      }

      console.log(`${ts()} [${jobId}] ✓ Seg ${i + 1} gerado`);
      segmentPaths.push(segPath);
    }
    console.log(`${ts()} [${jobId}] ✓ Todos os segmentos gerados`);

    // ── 5. Concatenar segmentos com concat demuxer ───────────────────
    console.log(`${ts()} [${jobId}] Concatenando segmentos...`);

    const listPath   = `/tmp/concatlist_${jobId}.txt`;
    const outputPath = `/tmp/output_${jobId}.mp4`;
    tmpFiles.push(listPath, outputPath);

    const listContent = segmentPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

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

    const videoBase64 = fs.readFileSync(outputPath).toString('base64');
    const filename    = `${pedidoId || jobId}.mp4`;

    console.log(`${ts()} [${jobId}] ========== CONCLUÍDO em ${tempoTotal}s ==========\n`);

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
  console.log(`${ts()} version: stable-basic-video-v1`);
  console.log(`${ts()} ffmpegPath: ${ffmpegPath || 'NÃO ENCONTRADO'}`);
});
