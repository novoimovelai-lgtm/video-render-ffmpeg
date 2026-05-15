const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();

app.use(cors());
app.use(express.json({ limit: "100mb" }));

const TMP_DIR = "/tmp";

app.get("/", (req, res) => {
  res.json({
    success: true,
    status: "online",
    message: "Novoimovel.AI Video Renderer Online",
    ffmpeg: ffmpegPath ? "available" : "not_found"
  });
});

async function downloadFile(url, outputPath) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000
  });

  fs.writeFileSync(outputPath, response.data);
}

function safeName(value) {
  return String(value || "pedido").replace(/[^a-zA-Z0-9-_]/g, "_");
}

app.post("/render-video", async (req, res) => {
  try {
    const {
      pedidoId = "teste",
      images = [],
      format = "9:16",
      music = "sem_trilha"
    } = req.body;

    if (!Array.isArray(images) || images.length < 5) {
      return res.status(400).json({
        success: false,
        error: "Envie pelo menos 5 imagens."
      });
    }

    if (!ffmpegPath) {
      return res.status(500).json({
        success: false,
        error: "FFmpeg não encontrado no servidor."
      });
    }

    const workDir = path.join(TMP_DIR, `${Date.now()}-${safeName(pedidoId)}`);
    fs.mkdirSync(workDir, { recursive: true });

    const localImages = [];

    for (let i = 0; i < images.length; i++) {
      const imagePath = path.join(workDir, `img_${i}.jpg`);
      await downloadFile(images[i], imagePath);
      localImages.push(imagePath);
    }

    const listPath = path.join(workDir, "list.txt");

    let listContent = "";

    localImages.forEach((imagePath) => {
      listContent += `file '${imagePath}'\n`;
      listContent += `duration 2\n`;
    });

    listContent += `file '${localImages[localImages.length - 1]}'\n`;

    fs.writeFileSync(listPath, listContent);

    const outputPath = path.join(workDir, `${safeName(pedidoId)}.mp4`);

    const size = format === "16:9" ? "1920:1080" : "1080:1920";

    const videoFilter = `scale=${size}:force_original_aspect_ratio=increase,crop=${size},format=yuv420p`;

    execFileSync(ffmpegPath, [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-vf", videoFilter,
      "-r", "30",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath
    ], {
      stdio: "pipe"
    });

    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString("base64");

    fs.rmSync(workDir, { recursive: true, force: true });

    return res.json({
      success: true,
      filename: `${safeName(pedidoId)}.mp4`,
      format,
      music,
      imageCount: images.length,
      videoBase64
    });

  } catch (error) {
    console.error("Erro ao renderizar vídeo:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Novoimovel.AI Video Renderer rodando na porta ${PORT}`);
});
