import { Color, CustomToneMapping, DirectionalLight, type Object3D, PCFShadowMap, type Scene, ShaderChunk, SpotLight, SRGBColorSpace, type Texture, Vector3, WebGLRenderer } from "three";
import { rgb } from "@ribbon/core/bookcase/cloth";

// The bookcase's light: a lamp-lit study, after Néstor Almendros on Days of Heaven. One believable source, little fill
// so the scene keeps its depth, muted colour, dark real wood, nothing white fighting the warm lamp. Overhead lamps at
// 3000 K, chosen by the owner from four moods on 7 November 2026 ("a PI's shelf in a Marlowe book").
// The Apple app's lamps are in packages/apple/Ribbon/Bookcase/Lamplight.swift; the numbers here are the ones that make
// this renderer's picture match that one's, found by measuring the two side by side (tools/shelf-proof).

/** Dark walnut: the case's back, and its boards. */
export const CASE_BACK = rgb(0x1f1610), CASE_BOARD = rgb(0x3b2a1c);

/** How the picture is lit and developed. Every number was found by comparison with the Apple app's picture. */
export interface Develop {
  /** A shelf lamp's strength, and the lamp over the book in your hand. */
  lamp: number;
  inHand: number;
  /** The lamps' colour temperature, in kelvin. */
  kelvin: number;
  /** How soft the edge of a lamp's pool is, against the Apple app's: 1 the same, less harder. */
  spread: number;
  /** The warmth bounced back from the room, and the studio's faint light on everything. */
  fill: number;
  studio: number;
  /** How far the studio is turned about the shelf, in degrees, so its lights stand where the Apple app's do. */
  studioTurn: number;
  /** How dark a shadow is, 0 to 1, and how soft its edge. */
  shadowDepth: number;
  shadowSoftness: number;
  /** How far a surface is held clear of its own shadow: along the lamp's ray, and along its own normal. */
  shadowBias: number;
  shadowNormalBias: number;
  /** The developing: exposure, the curve that rolls the highlights off, then contrast and colour. */
  exposure: number;
  curve: "none" | "reinhard" | "filmic";
  /** How bright a point must be to come out pure white, under the "reinhard" curve. */
  white: number;
  contrast: number;
  saturation: number;
}

export const LAMP: Develop = {
  lamp: 380_000,
  inHand: 1_440_000,
  kelvin: 3200,
  spread: 1,
  fill: 0.22,
  studio: 0.25,
  studioTurn: 180,
  shadowDepth: 0.85,
  shadowSoftness: 5,
  shadowBias: -0.0008,
  shadowNormalBias: 0.4,
  exposure: 1.3,
  curve: "reinhard",
  white: 2,
  contrast: 0.04,
  saturation: 0.88,
};

/** Where a shelf's lamps hang: spread along it, just under the shelf above, a little in front. */
export interface ShelfRig {
  width: number;
  shelfH: number;
  pad: number;
  depth: number;
  front: number;
  k: number;
}

/** A lamp's colour at a temperature, as a black body glows (Tanner Helland's fit), for the graphics card. */
export function glow(kelvin: number): Color {
  const t = kelvin / 100;
  const red = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const green = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const blue = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const part = (v: number) => Math.min(255, Math.max(0, v)) / 255;
  return new Color().setRGB(part(red), part(green), part(blue), SRGBColorSpace);
}

/** A shelf's lamps hang about every 260 points (at k = 1), spread evenly along it. */
export function lampCount(width: number, k: number): number {
  return Math.max(2, Math.round(width / (260 * k)));
}

/** A warm spot with soft shadows. Its light falls off as real light does. */
function spot(strength: number, innerDegrees: number, outerDegrees: number, d: Develop): SpotLight {
  const lamp = new SpotLight(glow(d.kelvin), strength, 0, ((outerDegrees / 2) * Math.PI) / 180, Math.min(1, (1 - innerDegrees / outerDegrees) * d.spread), 2);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  lamp.shadow.radius = d.shadowSoftness;
  lamp.shadow.intensity = d.shadowDepth;
  lamp.shadow.bias = d.shadowBias;
  lamp.shadow.normalBias = d.shadowNormalBias;
  return lamp;
}

function aim(scene: Scene, lamp: SpotLight | DirectionalLight, from: Vector3, at: Vector3): void {
  lamp.position.copy(from);
  lamp.target.position.copy(at);
  scene.add(lamp, lamp.target);
}

/** Everything but the lamps: the room's faint ambient and the fill bounced back from it. */
export function lightRoom(scene: Scene, studio: Texture, centre: Vector3, d: Develop): void {
  // Hardly any ambient: what isn't lit by the lamps falls away into shadow, as it would in a room at night.
  scene.environment = studio;
  scene.environmentIntensity = d.studio;
  scene.environmentRotation.y = (d.studioTurn * Math.PI) / 180;
  // The fill: a whisper of the lamp's own warmth bounced back from the room.
  const fill = new DirectionalLight(glow(2700), d.fill);
  const towards = new Vector3(0, -0.15, -1).normalize();
  aim(scene, fill, centre.clone().addScaledVector(towards, -2500), centre);
}

/** One of a shelf's overhead lamps. */
export function shelfLamp(d: Develop): SpotLight {
  return spot(d.lamp, 16, 64, d);
}

/** Hang a lamp under the shelf above, out in front, aimed down the spines: the tops catch the hot centre, the feet the edge of the cone. */
export function hangLamp(scene: Scene, lamp: SpotLight, x: number, s: ShelfRig): void {
  lamp.shadow.camera.near = 20 * s.k;
  lamp.shadow.camera.far = (s.pad + s.shelfH + s.depth) * 2.5;
  aim(scene, lamp, new Vector3(x, s.pad + s.shelfH + 10 * s.k, s.front + 70 * s.k), new Vector3(x, s.shelfH * 0.5, -s.depth * 0.1));
}

/** Light a shelf: its row of lamps, hung under the shelf above, out in front, aimed down the spines, so the tops catch the hot centre and the feet the edge of the cone. */
export function lightShelf(scene: Scene, studio: Texture, s: ShelfRig, d: Develop): void {
  lightRoom(scene, studio, new Vector3(s.width / 2, s.shelfH / 2, -s.depth / 2), d);
  const count = lampCount(s.width, s.k);
  for (let i = 0; i < count; i++) hangLamp(scene, shelfLamp(d), (s.width * (i + 0.5)) / count, s);
}

/** Light the book in your hand: one lamp over it. */
export function lightInHand(scene: Scene, studio: Texture, d: Develop): void {
  lightRoom(scene, studio, new Vector3(0, 0, 0), d);
  aim(scene, spot(d.inHand, 22, 60, d), new Vector3(-40, 520, 300), new Vector3(0, 0, 0));
}

const CURVES: Record<Develop["curve"], string> = {
  none: "c",
  // Erik Reinhard's curve: shadows as they are, highlights rolled off, pure white at WHITE.
  reinhard: "c * (1.0 + c / (WHITE * WHITE)) / (1.0 + c)",
  // Krzysztof Narkowicz's fit of the film curve.
  filmic: "(c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14)",
};

/**
 * Develop the picture as Almendros did: a little under-exposed rather than flattened with fill, colour kept muted.
 * The graphics card does it as it draws each point, so there's no second pass over the picture.
 */
function develop(d: Develop): void {
  const n = (v: number) => v.toFixed(4);
  ShaderChunk.tonemapping_pars_fragment = ShaderChunk.tonemapping_pars_fragment.replace(
    /vec3 CustomToneMapping\( vec3 color \) \{[^}]*\}/,
    `vec3 CustomToneMapping( vec3 color ) {
      vec3 c = max( color * toneMappingExposure, 0.0 );
      c = clamp( ${CURVES[d.curve].replaceAll("WHITE", n(d.white))}, 0.0, 1.0 );
      // Contrast and colour are judged as the eye sees the screen, not as light adds up.
      vec3 seen = pow( c, vec3( 1.0 / 2.2 ) );
      seen = ( seen - 0.5 ) * ${n(1 + d.contrast)} + 0.5;
      float grey = dot( seen, vec3( 0.2126, 0.7152, 0.0722 ) );
      seen = clamp( mix( vec3( grey ), seen, ${n(d.saturation)} ), 0.0, 1.0 );
      return pow( seen, vec3( 2.2 ) );
    }`,
  );
}

/** A renderer that draws the bookcase's scenes: soft shadows, smoothed edges, the picture developed as it's drawn. */
export function makeRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, d: Develop, keepPicture = false, clear = false): WebGLRenderer {
  develop(d);
  // `clear` draws over nothing, for the book in hand, which floats on the page.
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: clear, preserveDrawingBuffer: keepPicture });
  if (clear) renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.toneMapping = CustomToneMapping;
  renderer.toneMappingExposure = d.exposure;
  renderer.outputColorSpace = SRGBColorSpace;
  return renderer;
}

/**
 * Whether this machine has a graphics card to draw the bookcase with. Without one a browser draws 3D on the processor,
 * far too slowly for a page of lamps and shadows, and the bookcase stays flat.
 */
export function hasGraphicsCard(): boolean {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return false;
  const named = gl.getExtension("WEBGL_debug_renderer_info");
  const card = named ? String(gl.getParameter(named.UNMASKED_RENDERER_WEBGL)) : "";
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return !/swiftshader|llvmpipe|software|basic render/i.test(card);
}

/** Everything a scene holds, let go from the graphics card: its shapes, its materials, and their pictures. */
export function letGo(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as { geometry?: { dispose(): void }; material?: Record<string, unknown> | Record<string, unknown>[] };
    mesh.geometry?.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      // A copy of a shared texture lets go only of itself; the picture it shares stays for the others.
      for (const value of Object.values(m)) if ((value as Texture | null)?.isTexture) (value as Texture).dispose();
      (m as unknown as { dispose(): void }).dispose();
    }
  });
}
