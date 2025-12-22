const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const pngToIco = require("png-to-ico").default;

async function run() {
  const srcPng = path.join(__dirname, "assets", "icon-bri.png");
  const outIco = path.join(__dirname, "assets", "icon-bri.ico");

  // pastikan output 256x256 PNG dulu
  const tmp256 = path.join(__dirname, "assets", "__tmp_256.png");

  await sharp(srcPng).resize(256, 256).png().toFile(tmp256);

  const icoBuf = await pngToIco([tmp256]);
  fs.writeFileSync(outIco, icoBuf);

  fs.unlinkSync(tmp256);

  console.log("✅ ICO dibuat:", outIco);
}

run().catch((e) => {
  console.error("❌ gagal bikin ico:", e);
  process.exit(1);
});
