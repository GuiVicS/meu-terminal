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
    description: "Terminal, agentes de IA, arquivos e anotações do seu servidor",
    lang: "pt-BR",
    // Mesmo app instalado mesmo se o endereço de início mudar
    id: BASE_PATH || "/",
    start_url: BASE_PATH || "/",
    // Tocar no ícone com o app já aberto volta para ele (sem recarregar terminais e conversas)
    launch_handler: { client_mode: ["focus-existing", "auto"] },
    handle_links: "preferred",
    categories: ["developer", "productivity", "utilities"],
    scope: BASE_PATH || "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    background_color: "#121212",
    theme_color: "#121212",
    // Artwork is opaque and inside the maskable safe zone, so every icon is "any maskable".
    // PNGs cover platforms that ignore SVG manifest icons.
    icons: [
      {
        src: `${BASE_PATH}/assets/terminal-icon.svg`,
        type: "image/svg+xml",
        sizes: "any",
        purpose: "any maskable"
      },
      {
        src: `${BASE_PATH}/assets/icon-192.png`,
        type: "image/png",
        sizes: "192x192",
        purpose: "any maskable"
      },
      {
        src: `${BASE_PATH}/assets/icon-512.png`,
        type: "image/png",
        sizes: "512x512",
        purpose: "any maskable"
      }
    ],
    orientation: "any"
  };

  fs.writeFileSync(path.join(ASSETS_DIR, "manifest.json"), JSON.stringify(pwaManifest, null, 2));
  console.log("PWA manifest generated!");
}

/**
 * A second, separate manifest for /notas (see server.js): installs as its own app, distinct from
 * the main one, pointed at the same server and the same notes - own name/icon/start_url/scope so
 * the OS treats it as a different installed app, never the same login/data.
 */
function generateNotesManifest(siteTitle) {
  const notesManifest = {
    name: `Anotações — ${siteTitle}`,
    short_name: "Anotações",
    description: "Só as anotações, como um app separado - mesmas anotações do MeuTerminal.",
    id: `${BASE_PATH}/notas`,
    lang: "pt-BR",
    start_url: `${BASE_PATH}/notas`,
    scope: `${BASE_PATH}/notas`,
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    background_color: "#121212",
    theme_color: "#121212",
    icons: [
      {
        src: `${BASE_PATH}/assets/notes-icon.svg`,
        type: "image/svg+xml",
        sizes: "any",
        purpose: "any maskable"
      },
      {
        src: `${BASE_PATH}/assets/notes-icon-192.png`,
        type: "image/png",
        sizes: "192x192",
        purpose: "any maskable"
      },
      {
        src: `${BASE_PATH}/assets/notes-icon-512.png`,
        type: "image/png",
        sizes: "512x512",
        purpose: "any maskable"
      }
    ],
    orientation: "any"
  };

  fs.writeFileSync(path.join(ASSETS_DIR, "notes-manifest.json"), JSON.stringify(notesManifest, null, 2));
  console.log("Notes PWA manifest generated!");
}

module.exports = { generatePWAManifest, generateNotesManifest };