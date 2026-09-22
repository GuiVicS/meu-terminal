const fs = require("fs");
const path = require("path");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "assets");
const BASE_PATH = process.env.BASE_URL ? new URL(process.env.BASE_URL).pathname.replace(/\/$/, '') : '';

function getFiles(dir, basePath = "/") {
  let fileList = [];
  const files = fs.readdirSync(dir);
  const excludeList = [".DS_Store"]; // Add files or patterns to exclude here

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const fileUrl = path.join(basePath, file).replace(/\\/g, "/");

    if (fs.statSync(filePath).isDirectory()) {
      fileList = fileList.concat(getFiles(filePath, fileUrl));
    } else {
      if (!excludeList.includes(file)){
        fileList.push(fileUrl);
      }
    }
  });

  return fileList;
}

function generateAssetManifest() {
  console.log("Generating Asset manifest...");
  const assets = getFiles(PUBLIC_DIR);
  fs.writeFileSync(path.join(ASSETS_DIR, "asset-manifest.json"), JSON.stringify(assets, null, 2));
  console.log("Asset manifest generated!");
}

function generatePWAManifest(siteTitle) {
  generateAssetManifest(); // fetched later in service-worker

  const pwaManifest = {
    name: siteTitle,
    short_name: siteTitle,
    description: "A stupidly simple web-based terminal emulator",
    start_url: BASE_PATH || "/",
    scope: BASE_PATH || "/",
    display: "standalone",
    background_color: "#0A100F",
    theme_color: "#0A100F",
    icons: [
      {
        src: `${BASE_PATH}/assets/dumbterm.png`,
        type: "image/png",
        sizes: "192x192"
      },
      {
        src: `${BASE_PATH}/assets/dumbterm.png`,
        type: "image/png",
        sizes: "512x512"
      }
    ],
    orientation: "any"
  };

  fs.writeFileSync(path.join(ASSETS_DIR, "manifest.json"), JSON.stringify(pwaManifest, null, 2));
  console.log("PWA manifest generated!");
}

module.exports = { generatePWAManifest };