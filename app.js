// --------------------------------------------------
// Global state
// --------------------------------------------------
let voxModel = null;       // { size:{x,y,z}, voxels:[{x,y,z,c}], palette:[{r,g,b,a}] }
let library = null;        // { gpNames:[], grpNames:[] }
let colorUsage = null;     // Map colorIndex -> { count, hex }

// --------------------------------------------------
// DOM shortcuts
// --------------------------------------------------
const ui = {
  voxFile: document.getElementById("voxFile"),
  libFile: document.getElementById("libFile"),
  voxelSize: document.getElementById("voxelSize"),
  voxStatus: document.getElementById("voxStatus"),
  libStatus: document.getElementById("libStatus"),
  modelInfo: document.getElementById("modelInfo"),
  colorTableBody: document.querySelector("#colorTable tbody"),
  groupName: document.getElementById("groupName"),
  generateBtn: document.getElementById("generateBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  generateStatus: document.getElementById("generateStatus"),
  output: document.getElementById("output")
};

// --------------------------------------------------
// Helpers
// --------------------------------------------------
function rgbaToHex(r, g, b, a) {
  // Alpha is ignored for now, but we keep it available in the palette.
  const toHex = (v) => v.toString(16).padStart(2, "0");
  return "#" + toHex(r) + toHex(g) + toHex(b);
}

function readString(view, offset, length) {
  let s = "";
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}

// --------------------------------------------------
// VOX parsing (MagicaVoxel)
// --------------------------------------------------
function parseVoxArrayBuffer(buffer) {
  const view = new DataView(buffer);
  let offset = 0;

  // Header: "VOX " + version (int32)
  const magic = readString(view, offset, 4);
  offset += 4;
  if (magic !== "VOX ") {
    throw new Error("Not a VOX file (missing 'VOX ' header).");
  }
  const version = view.getInt32(offset, true);
  offset += 4;

  // Root chunk: MAIN
  const mainId = readString(view, offset, 4);
  offset += 4;
  if (mainId !== "MAIN") {
    throw new Error("Unexpected root chunk: " + mainId);
  }

  const mainContentSize = view.getInt32(offset, true);
  offset += 4;
  const mainChildrenSize = view.getInt32(offset, true);
  offset += 4;

  // Skip MAIN content block (usually 0)
  offset += mainContentSize;

  const endOfChildren = offset + mainChildrenSize;

  let size = null;          // {x,y,z}
  let voxels = [];          // array of {x,y,z,c}
  let palette = null;       // array of {r,g,b,a} length 256

  // Iterate child chunks inside MAIN
  while (offset < endOfChildren) {
    const chunkId = readString(view, offset, 4);
    offset += 4;
    const contentSize = view.getInt32(offset, true);
    offset += 4;
    const childrenSize = view.getInt32(offset, true);
    offset += 4;

    const contentStart = offset;
    const childrenStart = contentStart + contentSize;

    if (chunkId === "SIZE") {
      // SIZE: int32 x, y, z
      const sx = view.getInt32(contentStart + 0, true);
      const sy = view.getInt32(contentStart + 4, true);
      const sz = view.getInt32(contentStart + 8, true);
      size = { x: sx, y: sy, z: sz };
    } else if (chunkId === "XYZI") {
      // XYZI: int32 numVoxels; then numVoxels * 4 bytes (x,y,z,colorIndex)
      const numVoxels = view.getInt32(contentStart, true);
      const base = contentStart + 4;
      voxels = [];
      for (let i = 0; i < numVoxels; i++) {
        const x = view.getUint8(base + i * 4 + 0);
        const y = view.getUint8(base + i * 4 + 1);
        const z = view.getUint8(base + i * 4 + 2);
        const c = view.getUint8(base + i * 4 + 3); // color index: 1..255
        voxels.push({ x, y, z, c });
      }
    } else if (chunkId === "RGBA") {
      // RGBA: 256 * 4 bytes of (r,g,b,a)
      palette = [];
      for (let i = 0; i < 256; i++) {
        const base = contentStart + i * 4;
        const r = view.getUint8(base + 0);
        const g = view.getUint8(base + 1);
        const b = view.getUint8(base + 2);
        const a = view.getUint8(base + 3);
        palette.push({ r, g, b, a });
      }
    }

    // Skip content + children of this chunk
    offset = childrenStart + childrenSize;
  }

  if (!size || voxels.length === 0) {
    throw new Error("No SIZE or XYZI chunk found in VOX file.");
  }

  // If there is no RGBA chunk, we can still build a dummy palette
  if (!palette) {
    palette = new Array(256).fill(0).map((_, i) => {
      const v = i; // simple gradient fallback
      return { r: v, g: v, b: v, a: 255 };
    });
  }

  return { size, voxels, palette, version };
}

function handleVoxFile(file) {
  ui.voxStatus.textContent = "Loading VOX...";
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const buffer = ev.target.result;
      voxModel = parseVoxArrayBuffer(buffer);
      ui.voxStatus.textContent = `Loaded: ${file.name}`;
      updateModelInfo();
      buildColorUsage();
      rebuildColorTable();
    } catch (err) {
      console.error(err);
      ui.voxStatus.textContent = "Error parsing VOX: " + err.message;
      ui.modelInfo.textContent = "Parsing failed.";
      voxModel = null;
      colorUsage = null;
      ui.colorTableBody.innerHTML = "";
    }
  };
  reader.onerror = () => {
    ui.voxStatus.textContent = "File read error.";
  };
  reader.readAsArrayBuffer(file);
}

function updateModelInfo() {
  if (!voxModel) {
    ui.modelInfo.textContent = "No VOX model parsed yet.";
    return;
  }
  const { size, voxels, version } = voxModel;
  ui.modelInfo.textContent =
    `Version: ${version} | Size: ${size.x} × ${size.y} × ${size.z} | Voxels: ${voxels.length}`;
}

function buildColorUsage() {
  if (!voxModel) return;
  const { voxels, palette } = voxModel;
  const map = new Map();

  for (const v of voxels) {
    const idx = v.c; // 1..255, 0 is unused
    if (!map.has(idx)) {
      const palEntry = palette[idx - 1] || { r: 255, g: 0, b: 255, a: 255 };
      const hex = rgbaToHex(palEntry.r, palEntry.g, palEntry.b, palEntry.a);
      map.set(idx, { count: 0, hex });
    }
    map.get(idx).count++;
  }

  // Sort by color index
  colorUsage = new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
}

// --------------------------------------------------
// Library JSON parsing
// --------------------------------------------------
function handleLibraryFile(file) {
  ui.libStatus.textContent = "Loading library...";
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const text = String(ev.target.result);
      const json = JSON.parse(text);

      const gpNames = json.gamePrimitives
        ? Object.keys(json.gamePrimitives)
        : [];
      const grpNames = json.groups ? Object.keys(json.groups) : [];

      library = { gpNames, grpNames };

      ui.libStatus.textContent =
        `Library loaded: ${file.name} | GP: ${gpNames.length} | GRP: ${grpNames.length}`;

      // If the color table is already present, the name selects will pick up data on change.
      // Nothing else needed here.
    } catch (err) {
      console.error(err);
      ui.libStatus.textContent = "Error parsing library: " + err.message;
      library = null;
    }
  };
  reader.onerror = () => {
    ui.libStatus.textContent = "File read error.";
  };
  reader.readAsText(file);
}

// --------------------------------------------------
// Color table UI
// --------------------------------------------------
function rebuildColorTable() {
  ui.colorTableBody.innerHTML = "";

  if (!colorUsage) return;

  let rowIndex = 1;
  for (const [colorIndex, info] of colorUsage.entries()) {
    const tr = document.createElement("tr");
    tr.dataset.colorIndex = String(colorIndex);
    tr.dataset.colorHex = info.hex;

    const tdIdx = document.createElement("td");
    tdIdx.textContent = String(rowIndex);
    tr.appendChild(tdIdx);

    const tdSwatch = document.createElement("td");
    const sw = document.createElement("div");
    sw.className = "color-swatch";
    sw.style.backgroundColor = info.hex;
    tdSwatch.appendChild(sw);
    tr.appendChild(tdSwatch);

    const tdHex = document.createElement("td");
    tdHex.textContent = `${info.hex} (idx ${colorIndex})`;
    tr.appendChild(tdHex);

    const tdCount = document.createElement("td");
    tdCount.textContent = String(info.count);
    tr.appendChild(tdCount);

    const tdType = document.createElement("td");
    const typeSelect = document.createElement("select");
    typeSelect.className = "map-type";
    const optNone = new Option("(none)", "", true, true);
    const optGp = new Option("GP", "gp");
    const optGrp = new Option("GRP", "grp");
    typeSelect.add(optNone);
    typeSelect.add(optGp);
    typeSelect.add(optGrp);
    tdType.appendChild(typeSelect);
    tr.appendChild(tdType);

    const tdName = document.createElement("td");
    const nameSelect = document.createElement("select");
    nameSelect.className = "map-name";
    const optPlaceholder = new Option("-- select --", "", true, true);
    nameSelect.add(optPlaceholder);
    tdName.appendChild(nameSelect);
    tr.appendChild(tdName);

    // When type changes, rebuild name options from library
    typeSelect.addEventListener("change", () => {
      rebuildNameOptionsForRow(tr);
    });

    ui.colorTableBody.appendChild(tr);
    rowIndex++;
  }
}

function rebuildNameOptionsForRow(tr) {
  const typeSelect = tr.querySelector("select.map-type");
  const nameSelect = tr.querySelector("select.map-name");
  const selectedType = typeSelect.value;

  // Clear name select
  nameSelect.innerHTML = "";
  const optPlaceholder = new Option("-- select --", "", true, true);
  nameSelect.add(optPlaceholder);

  if (!library) {
    // No library loaded: keep empty, user has to load a library first
    return;
  }

  if (selectedType === "gp") {
    for (const name of library.gpNames) {
      nameSelect.add(new Option(name, name));
    }
  } else if (selectedType === "grp") {
    for (const name of library.grpNames) {
      nameSelect.add(new Option(name, name));
    }
  }
}

// --------------------------------------------------
// Group JSON generation
// --------------------------------------------------
function collectMappings() {
  const mappings = new Map(); // colorIndex -> { refType, refName }

  const rows = ui.colorTableBody.querySelectorAll("tr");
  for (const tr of rows) {
    const colorIndex = Number(tr.dataset.colorIndex);
    const typeSelect = tr.querySelector("select.map-type");
    const nameSelect = tr.querySelector("select.map-name");
    const refType = typeSelect.value;
    const refName = nameSelect.value.trim();

    if (!refType || !refName) {
      continue; // no mapping for this color
    }

    mappings.set(colorIndex, { refType, refName });
  }

  return mappings;
}

function generateGroupJSON() {
  ui.generateStatus.textContent = "";

  if (!voxModel) {
    ui.generateStatus.textContent = "No VOX model loaded.";
    return;
  }

  const mappings = collectMappings();
  if (mappings.size === 0) {
    ui.generateStatus.textContent = "No color mappings defined.";
    return;
  }

  const groupName = ui.groupName.value.trim() || "VoxelImport01";
  const size = parseFloat(ui.voxelSize.value) || 1.0;
  const { voxels } = voxModel;

  const items = [];

  for (const v of voxels) {
    const map = mappings.get(v.c);
    if (!map) {
      continue; // this voxel's color is not mapped to any object
    }

    const { refType, refName } = map;

    // Coordinate mapping:
    // Here we use a simple mapping: x -> x, y -> y, z -> z (scaled).
    // Adjust this mapping if your game uses a different axis convention.
    const px = v.x * size;
    const py = v.y * size;
    const pz = v.z * size;

    items.push({
      refType,
      refName,
      pos: [px, py, pz],
      rotRYP: [0, 0, 0],
      scale: [1, 1, 1]
    });
  }

  const group = {
    name: groupName,
    items
  };

  // Wrap it in a "groups" object to match your library JSON style.
  const out = {
    groups: {
      [groupName]: group
    }
  };

  const jsonText = JSON.stringify(out, null, 2);
  ui.output.value = jsonText;
  ui.generateStatus.textContent = `Generated group with ${items.length} items.`;
  ui.downloadBtn.disabled = false;
}

// --------------------------------------------------
// Download helper
// --------------------------------------------------
function downloadOutputJSON() {
  const text = ui.output.value;
  if (!text.trim()) return;

  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  const groupName = ui.groupName.value.trim() || "VoxelImport01";
  a.href = url;
  a.download = groupName + ".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

// --------------------------------------------------
// Event wiring
// --------------------------------------------------
ui.voxFile.addEventListener("change", () => {
  const file = ui.voxFile.files[0];
  if (!file) return;
  handleVoxFile(file);
});

ui.libFile.addEventListener("change", () => {
  const file = ui.libFile.files[0];
  if (!file) return;
  handleLibraryFile(file);
});

ui.generateBtn.addEventListener("click", () => {
  generateGroupJSON();
});

ui.downloadBtn.addEventListener("click", () => {
  downloadOutputJSON();
});
