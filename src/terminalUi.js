import { buildOasesWebUrl, openOasesWeb } from "./open.js";

const RESET = "\x1b[0m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J";
const CURSOR_HOME = "\x1b[H";

function color(r, g, b, text) {
  return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function dim(text) {
  return `\x1b[2m${text}${RESET}`;
}

function bold(text) {
  return `\x1b[1m${text}${RESET}`;
}

const OASES_MASK = [
  "                   #############",
  "                  ################.",
  "                 ####################",
  "                 #####################",
  "                 #######################",
  "                  #######################",
  "                  ########################",
  "                   ########################",
  "                   #########################",
  "                   #########################",
  "                  ##########################",
  "    ###        .############################",
  " ###########################################",
  "###########################################",
  "#####################            ########",
  "###################",
  "###################",
  " ##################",
  "   ################",
  "    ###############",
  "      #############",
  "         #########",
];
const OASES_WIDTH = Math.max(...OASES_MASK.map((row) => row.length));
const OASES_HEIGHT = OASES_MASK.length;

function isExplicitAnsiWindowsTerminal(env = process.env) {
  return Boolean(
    env.WT_SESSION ||
      env.TERM_PROGRAM ||
      env.ANSICON ||
      env.ConEmuANSI === "ON" ||
      /^(xterm|vt100|vt220|screen|tmux|rxvt)/i.test(env.TERM || ""),
  );
}

export function supportsInteractiveUi(stream = process.stdout, env = process.env, platform = process.platform) {
  if (env.OCLI_ANIMATED_UI === "1") return Boolean(stream.isTTY && env.CI !== "true" && env.TERM !== "dumb");
  if (platform === "win32" && !isExplicitAnsiWindowsTerminal(env)) return false;
  return Boolean(
    stream.isTTY &&
      env.CI !== "true" &&
      env.TERM !== "dumb" &&
      env.NO_COLOR === undefined &&
      env.OCLI_PLAIN_UI !== "1",
  );
}

function baseMaskAt(row, column) {
  return OASES_MASK[row]?.[column] || " ";
}

function sampleMaskAt(row, column, frame) {
  const x = column / Math.max(1, OASES_WIDTH - 1);
  const y = row / Math.max(1, OASES_HEIGHT - 1);
  const phase = Math.sin(frame * 0.075);
  const upperRight = { x: 0.68, y: 0.36, rx: 0.36, ry: 0.38, scale: 1 + 0.24 * phase };
  const lowerLeft = { x: 0.18, y: 0.78, rx: 0.25, ry: 0.27, scale: 1 - 0.24 * phase };
  const lobes = [upperRight, lowerLeft];
  let sampleX = x;
  let sampleY = y;

  for (const lobe of lobes) {
    const influence = gaussian(x, y, lobe.x, lobe.y, lobe.rx, lobe.ry);
    const targetX = lobe.x + (x - lobe.x) / lobe.scale;
    const targetY = lobe.y + (y - lobe.y) / lobe.scale;
    sampleX += (targetX - x) * influence * 0.94;
    sampleY += (targetY - y) * influence * 0.94;
  }

  const sampledColumn = Math.round(sampleX * (OASES_WIDTH - 1));
  const sampledRow = Math.round(sampleY * (OASES_HEIGHT - 1));
  return baseMaskAt(sampledRow, sampledColumn);
}

function hasNeighbor(row, column, frame) {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      if (sampleMaskAt(row + dy, column + dx, frame) === "#") return true;
    }
  }
  return false;
}

function isBoundary(row, column, frame) {
  return sampleMaskAt(row, column, frame) === "#" && (
    sampleMaskAt(row - 1, column, frame) !== "#" ||
    sampleMaskAt(row + 1, column, frame) !== "#" ||
    sampleMaskAt(row, column - 1, frame) !== "#" ||
    sampleMaskAt(row, column + 1, frame) !== "#"
  );
}

function stableNoise(row, column) {
  const value = Math.sin(row * 12.9898 + column * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function gaussian(x, y, centerX, centerY, radiusX, radiusY) {
  return Math.exp(-((x - centerX) ** 2 / (radiusX ** 2) + (y - centerY) ** 2 / (radiusY ** 2)));
}

function lobeExchange(row, column, frame) {
  const x = column / Math.max(1, OASES_WIDTH - 1);
  const y = row / Math.max(1, OASES_HEIGHT - 1);
  const exchange = Math.sin(frame * 0.075);
  const upperRight = gaussian(x, y, 0.67, 0.34, 0.34, 0.34);
  const lowerLeft = gaussian(x, y, 0.24, 0.77, 0.24, 0.28);
  return (lowerLeft - upperRight) * exchange;
}

function greenDot(strength, glyph = "●") {
  if (strength > 0.82) return color(0, 215, 75, glyph);
  if (strength > 0.62) return color(0, 190, 72, glyph);
  if (strength > 0.42) return color(23, 155, 64, glyph);
  return color(30, 105, 52, glyph === "●" ? "•" : glyph);
}

export function renderOasesFrame(frame = 0) {
  const lines = [];
  for (let row = 0; row < OASES_HEIGHT; row += 1) {
    let line = "";
    for (let column = 0; column < OASES_WIDTH; column += 1) {
      const cell = sampleMaskAt(row, column, frame);
      const noise = stableNoise(row, column);
      const exchange = lobeExchange(row, column, frame);
      const wave = Math.sin(frame * 0.42 + column * 0.22 - row * 0.36);
      const edgePulse = 0.18 * wave + 0.32 * exchange;

      if (cell === "#") {
        const boundary = isBoundary(row, column, frame);
        const shrinkingEdge = boundary && edgePulse < -0.24 && noise > 0.58;
        const strength = 0.78 + 0.16 * wave + 0.18 * exchange - (shrinkingEdge ? 0.42 : 0);
        line += greenDot(strength, shrinkingEdge ? "•" : "●");
        continue;
      }

      if (cell === ".") {
        line += greenDot(0.34 + edgePulse, "·");
        continue;
      }

      const expandingEdge = hasNeighbor(row, column, frame) && edgePulse > 0.2 && noise > 0.38;
      line += expandingEdge ? greenDot(0.32 + edgePulse, noise > 0.72 ? "•" : "·") : " ";
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

function plainStartupLog({ port, workspace, token, version, runtimeSource }) {
  console.log(`ocli ${version} (${runtimeSource}) listening on http://127.0.0.1:${port}`);
  console.log(`workspace: ${workspace}`);
  if (token) console.log(`token: ${token}`);
  console.log(`web: ${buildOasesWebUrl(token)}`);
  console.log("正在运行ocli，请打开https://www.oasesai.xyz 选择“工程模式”配合使用");
}

function renderStatus({ frame, port, workspace, token, version, runtimeSource }) {
  const title = `${bold(`ocli ${version}`)} ${dim(`(${runtimeSource})`)} ${color(0, 215, 75, "●")} 正在运行`;
  const lines = [
    renderOasesFrame(frame),
    "",
    title,
    `${dim("local:")} http://127.0.0.1:${port}`,
    `${dim("workspace:")} ${workspace}`,
  ];
  if (token) lines.push(`${dim("token:")} ${token}`);
  lines.push("", `${color(0, 215, 75, "正在运行ocli")}，请打开${bold("https://www.oasesai.xyz")} 选择${bold("“工程模式”")}配合使用`);
  if (token) lines.push(`${dim("web token link:")} ${buildOasesWebUrl(token)}`);
  lines.push(dim("启动 6 秒后会自动打开 Oases Web"));
  lines.push(dim("按 Ctrl+C 停止 ocli"));
  return lines.join("\n");
}

export function startTerminalStatusUi(options) {
  if (!supportsInteractiveUi()) {
    plainStartupLog(options);
    const openTimer = process.stdout.isTTY && process.env.CI !== "true" ? setTimeout(() => openOasesWeb(options.token), 6000) : undefined;
    return {
      stop() {
        if (openTimer) clearTimeout(openTimer);
      },
    };
  }

  let frame = 0;
  let stopped = false;
  let timer;
  let openTimer;
  const write = (chunk) => process.stdout.write(chunk);
  const draw = () => {
    write(`${CURSOR_HOME}${CLEAR_SCREEN}${renderStatus({ ...options, frame })}\n`);
    frame += 1;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (openTimer) clearTimeout(openTimer);
    process.removeListener("exit", stop);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    write(SHOW_CURSOR);
  };
  const stopAndExit = (code) => {
    stop();
    process.exit(code);
  };
  const onSigint = () => stopAndExit(0);
  const onSigterm = () => stopAndExit(143);

  write(HIDE_CURSOR);
  draw();
  timer = setInterval(draw, 120);
  openTimer = setTimeout(() => openOasesWeb(options.token), 6000);
  process.once("exit", stop);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return { stop };
}
