// The guide mascot: the logo character drawn as inline SVG from the brand
// vectors (body, cream eyes, sleep cap from the night scene). Decorative only;
// guide.css styles it and hides it in forced colors.

const SVG = "http://www.w3.org/2000/svg";
export const MASCOT_POSES = Object.freeze(["idle", "look", "happy", "thinking", "worried", "waiting"]);

function draw(name, attributes, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  parent?.append(node);
  return node;
}

export function createMascot() {
  const svg = draw("svg", {
    class: "rm-mascot", viewBox: "-8 -34 140 168", "aria-hidden": "true", focusable: "false", "data-pose": "idle",
  });
  const figure = draw("g", { class: "rm-mascot__figure" }, svg);
  draw("path", { class: "rm-mascot__body", d: "M0 126V47C0 17 18 0 48 0s48 17 48 47v79z" }, figure);
  const eyes = draw("g", { class: "rm-mascot__eyes" }, figure);
  for (const cx of [30, 66]) draw("circle", { class: "rm-mascot__eye", cx, cy: 47, r: 10 }, eyes);
  draw("path", { class: "rm-mascot__arcs rm-mascot__happy", d: "M20 51Q30 37 40 51M56 51Q66 37 76 51" }, figure);
  draw("path", { class: "rm-mascot__arcs rm-mascot__closed", d: "M21 45Q30 53 39 45M57 45Q66 53 75 45" }, figure);
  const cap = draw("g", { class: "rm-mascot__cap" }, figure);
  // Night-scene cap blue (web DoorwayHero --doorway-cap). Illustration only.
  draw("path", {
    class: "rm-mascot__line", fill: "oklch(58% 0.08 230)",
    d: "M4 12Q10-24 48-28Q86-31 98-5L111 10Q90 8 82-5Q73-13 66-6L91 12Z",
  }, cap);
  draw("path", { class: "rm-mascot__arcs", d: "M22 8Q26-12 43-23M48 8Q50-5 59-12" }, cap);
  draw("rect", { class: "rm-mascot__cream rm-mascot__line", x: 1, y: 8, width: 94, height: 13, rx: 6.5 }, cap);
  draw("circle", { class: "rm-mascot__cream rm-mascot__line", cx: 111, cy: 11, r: 7 }, cap);
  const warning = draw("g", { class: "rm-mascot__warning" }, svg);
  draw("path", { class: "rm-mascot__mark", d: "M114 62 131 92H97Z" }, warning);
  draw("path", { class: "rm-mascot__mark-line", d: "M114 72v9M114 86v1" }, warning);
  return svg;
}

// look shifts the eyes up to 4 units toward (dx, dy); thinking looks up.
export function setMascotPose(svg, pose, { dx = 0, dy = 0 } = {}) {
  const name = MASCOT_POSES.includes(pose) ? pose : "idle";
  const clamp = (value) => Math.round(Math.max(-4, Math.min(4, Number(value) || 0)));
  const shift = name === "look" ? `${clamp(dx)} ${clamp(dy)}` : name === "thinking" ? "0 -4" : "0 0";
  const eyes = svg.querySelector(".rm-mascot__eyes");
  if (svg.getAttribute("data-pose") !== name) svg.setAttribute("data-pose", name);
  if (eyes.getAttribute("transform") !== `translate(${shift})`) eyes.setAttribute("transform", `translate(${shift})`);
  for (const eye of svg.querySelectorAll(".rm-mascot__eye")) eye.setAttribute("r", name === "worried" ? "7" : "10");
}
