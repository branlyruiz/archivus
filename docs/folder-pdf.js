const width = 595;
const height = 842;
const margin = 42;
const right = width - margin;
const bottom = 785;
const red = "#e20e17";
const ink = "#05141d";
const muted = "#505b61";

function wrap(context, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const word of text.trim().split(/\s+/u)) {
    const candidate = line ? line + " " + word : word;
    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    for (const character of word) {
      if (context.measureText(line + character).width > maxWidth) {
        lines.push(line);
        line = "";
      }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function makePages(groups) {
  const pages = [];
  let ctx;
  let y;
  const allFolders = groups.flatMap(({ folders }) => folders);
  const found = allFolders.filter((folder) => folder.found).length;
  const date = new Intl.DateTimeFormat("es-CO", { dateStyle: "long" }).format(new Date());

  function text(value, x, baseline, size, color = ink, weight = 400) {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px system-ui, sans-serif`;
    ctx.fillText(value, x, baseline);
  }

  function startPage() {
    const canvas = document.createElement("canvas");
    canvas.width = width * 2;
    canvas.height = height * 2;
    ctx = canvas.getContext("2d", { alpha: false });
    ctx.scale(2, 2);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = red;
    ctx.fillRect(0, 0, width, 7);
    text("ARCHIVUS", margin, 48, 11, red, 750);
    text("Lista de búsqueda", margin, 82, 26, ink, 740);
    text(`${date}  ·  ${found} de ${allFolders.length} encontradas`, margin, 106, 11, muted);
    pages.push({ canvas, ctx });
    y = 128;
  }

  function diskHeading(name) {
    ctx.font = "700 13px system-ui, sans-serif";
    const lines = wrap(ctx, name, right - margin - 24);
    const boxHeight = lines.length * 17 + 16;
    if (y + boxHeight + 42 > bottom) startPage();
    ctx.fillStyle = "#ededed";
    ctx.fillRect(margin, y, right - margin, boxHeight);
    ctx.fillStyle = red;
    ctx.fillRect(margin, y, 3, boxHeight);
    lines.forEach((line, index) => text(line, margin + 12, y + 20 + index * 17, 13, ink, 700));
    y += boxHeight + 8;
  }

  startPage();
  for (const { name, folders } of groups) {
    diskHeading(name);
    for (const { found, trail } of folders) {
      const title = trail.at(-1)?.name ?? "Carpeta no disponible";
      const route = trail.map((item) => item.name).join(" › ");
      const left = margin + 31;
      ctx.font = "700 12px system-ui, sans-serif";
      const nameLines = wrap(ctx, title, right - left);
      ctx.font = "400 10px system-ui, sans-serif";
      const routeLines = wrap(ctx, route, right - left);
      if (y + nameLines.length * 16 + 16 > bottom) {
        startPage();
        diskHeading(name);
      }
      ctx.strokeStyle = found ? red : muted;
      ctx.lineWidth = 1;
      ctx.strokeRect(margin + 7, y + 2, 12, 12);
      if (found) text("✓", margin + 8, y + 13, 12, red, 750);
      for (const line of nameLines) {
        text(line, left, y + 13, 12, ink, 700);
        y += 16;
      }
      for (const line of routeLines) {
        if (y + 18 > bottom) {
          startPage();
          diskHeading(name);
        }
        text(line, left, y + 10, 10, muted);
        y += 14;
      }
      y += 7;
      ctx.strokeStyle = "#dedede";
      ctx.beginPath();
      ctx.moveTo(margin, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      y += 11;
    }
    y += 8;
  }

  return pages.map(({ canvas, ctx }, index) => {
    ctx.fillStyle = muted;
    ctx.font = "400 10px system-ui, sans-serif";
    ctx.fillText(`Discos W Agencia  ·  ${index + 1} / ${pages.length}`, margin, 815);
    return Uint8Array.from(atob(canvas.toDataURL("image/jpeg", .9).split(",")[1]), (char) => char.charCodeAt(0));
  });
}

export function makeFolderPdf(groups) {
  const images = makePages(groups);
  const encoder = new TextEncoder();
  const parts = [];
  const offsets = [0];
  let length = 0;
  const append = (value) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    parts.push(bytes);
    length += bytes.byteLength;
  };
  const object = (...body) => {
    const number = offsets.length;
    offsets.push(length);
    append(`${number} 0 obj\n`);
    body.forEach(append);
    append("\nendobj\n");
  };
  append("%PDF-1.4\n");
  object("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = images.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  object(`<< /Type /Pages /Count ${images.length} /Kids [${kids}] >>`);
  for (const [i, image] of images.entries()) {
    const page = 3 + i * 3;
    object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Sheet ${page + 1} 0 R >> >> /Contents ${page + 2} 0 R >>`);
    object(`<< /Type /XObject /Subtype /Image /Width ${width * 2} /Height ${height * 2} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.byteLength} >>\nstream\n`, image, "\nendstream");
    const commands = `q ${width} 0 0 ${height} 0 0 cm /Sheet Do Q\n`;
    object(`<< /Length ${commands.length} >>\nstream\n${commands}endstream`);
  }
  const xref = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) append(`${String(offset).padStart(10, "0")} 00000 n \n`);
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}
