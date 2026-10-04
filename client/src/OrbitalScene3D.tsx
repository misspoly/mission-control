import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

/**
 * True-3D orbital ops stage (Three.js/WebGL).
 *
 * Scene recipe (3D gaming mission-control design playbook + 2026-10-04
 * 3D timeline upgrade brief):
 * emissive Fresnel core + status-shaped nodes (active = sphere,
 * paused = cube, failed = octahedron, disabled = icosahedron — shape +
 * color + text label, never color alone) on two tilted orbit rings.
 * Every node carries a countdown arc that fills as its next run
 * approaches; additive core→node beams pulse when a fresh snapshot
 * lands; particle starfield, polar grid floor, FogExp2 depth falloff,
 * UnrealBloom on desktop-class devices. No real point lights — emissive
 * materials + glow sprites carry the look. The camera never auto-orbits:
 * drag to orbit, tap a node and it dollies in (600ms ease-out) and
 * freezes the orbit, game-inspect style.
 *
 * Performance: orbit ring guides are one merged BufferGeometry; label
 * legibility passes run at ~5Hz, not per frame; if the frame rate stays
 * under 45fps the scene steps down (bloom → pixel ratio → 2D fallback).
 */

export type SceneNodeState = "active" | "paused" | "disabled" | "failed" | "pending" | "running";

export type SceneNode = {
  id: string;
  code: string;
  title: string;
  state: SceneNodeState;
  isNext: boolean;
  /** Parsed cadence period in ms (null when the cadence is unknown). */
  cadenceMs: number | null;
  lastRunMs: number | null;
  nextRunMs: number | null;
};

const STATE_HEX: Record<SceneNodeState, number> = {
  active: 0x00ff88,
  paused: 0xffb24d,
  disabled: 0x8899aa,
  failed: 0xff2d55,
  pending: 0x22d3ee,
  running: 0x00f0ff,
};

const STATE_WORD: Record<SceneNodeState, string> = {
  active: "ACTIVE",
  paused: "PAUSED",
  disabled: "DISABLED",
  failed: "FAILED",
  pending: "PENDING",
  running: "RUNNING",
};

/**
 * How full a node's countdown arc is: 0 just after a run, 1 when the
 * next run is due. The period comes from the cadence, or from the
 * last→next run span when the cadence string can't be parsed.
 */
function runFrac(sn: SceneNode, nowMs: number): number | null {
  // Running shows an indeterminate energetic ring, not a countdown;
  // pending sits nearly full — queued and about to fire.
  if (sn.state === "running") return null;
  if (sn.nextRunMs == null) return null;
  if (sn.state === "pending") return 0.92;
  if (sn.nextRunMs <= nowMs) return 1;
  let period = sn.cadenceMs;
  if (!period && sn.lastRunMs != null && sn.nextRunMs > sn.lastRunMs) {
    period = sn.nextRunMs - sn.lastRunMs;
  }
  if (!period || period <= 0) return null;
  return Math.max(0, Math.min(1, 1 - (sn.nextRunMs - nowMs) / period));
}

function countdownText(nextMs: number | null, nowMs: number): string {
  if (nextMs == null) return "";
  const diff = nextMs - nowMs;
  if (diff <= 0) return "DUE";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "<1M";
  if (mins < 60) return `${mins}M`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}H ${String(m).padStart(2, "0")}M` : `${h}H`;
}

type Node3D = {
  id: string;
  group: THREE.Group;
  core: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  wire: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  ringMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  arc: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  glow: THREE.Sprite;
  labelObj: CSS2DObject;
  labelEl: HTMLDivElement;
  labelCode: HTMLSpanElement;
  labelStatus: HTMLSpanElement;
  labelNext: HTMLSpanElement;
  labelRun: HTMLSpanElement;
  ringIndex: number;
  angle: number;
  phase: number;
  state: SceneNodeState;
  isNext: boolean;
  nextRunMs: number | null;
  cdText: string;
  scaleCur: number;
};

type CamTween = {
  t: number;
  dur: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTgt: THREE.Vector3;
  toTgt: THREE.Vector3;
};

type SyncData = {
  nodes: SceneNode[];
  selectedId: string | null;
  highlightId: string | null;
  coreState: SceneNodeState;
  coreLabel: string;
  animate: boolean;
  pulseKey: string | null;
};

const RING_DEFS = [
  { radius: 3.2, tilt: 0.1, speed: (Math.PI * 2) / 90 },
  { radius: 4.6, tilt: -0.21, speed: -(Math.PI * 2) / 115 },
] as const;

const OVERVIEW_POS = new THREE.Vector3(0, 5.2, 10.5);
const ORIGIN = new THREE.Vector3(0, 0, 0);

function makeGlowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
    grad.addColorStop(0.6, "rgba(255,255,255,0.12)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export default function OrbitalScene3D({
  nodes,
  selectedId,
  coreState,
  coreLabel,
  animate,
  hudTime,
  trackingLabel,
  highlightId,
  syncPulseKey,
  onSelect,
  onHover,
  onWebglFail,
}: {
  nodes: SceneNode[];
  selectedId: string | null;
  coreState: SceneNodeState;
  coreLabel: string;
  animate: boolean;
  hudTime: string;
  trackingLabel: string;
  highlightId?: string | null;
  syncPulseKey?: string | null;
  onSelect: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  onWebglFail: () => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<{ sync: (d: SyncData) => void } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const onFailRef = useRef(onWebglFail);
  onFailRef.current = onWebglFail;

  // Latest props for the scene's sync entry point (idempotent, cheap).
  const dataRef = useRef<SyncData>({
    nodes,
    selectedId,
    highlightId: highlightId ?? null,
    coreState,
    coreLabel,
    animate,
    pulseKey: syncPulseKey ?? null,
  });
  dataRef.current = {
    nodes,
    selectedId,
    highlightId: highlightId ?? null,
    coreState,
    coreLabel,
    animate,
    pulseKey: syncPulseKey ?? null,
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      onFailRef.current();
      return;
    }

    const coarsePointer =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 560;
    const lowTier = coarsePointer || smallScreen;

    renderer.setClearColor(0x04070c, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowTier ? 1.25 : 2));
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    mount.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(mount.clientWidth, mount.clientHeight);
    labelRenderer.domElement.style.position = "absolute";
    labelRenderer.domElement.style.inset = "0";
    labelRenderer.domElement.style.pointerEvents = "none";
    mount.appendChild(labelRenderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x04060b, 0.014);

    const camera = new THREE.PerspectiveCamera(
      45,
      Math.max(1, mount.clientWidth) / Math.max(1, mount.clientHeight),
      0.1,
      300,
    );
    // Pull the overview back until the whole orbit fits the frame: the
    // outer ring (r=4.6) plus node labels must clear both axes —
    // including nodes swinging through the near side of the orbit,
    // where perspective projects them widest. Narrow stages get an
    // extra pull-back so nothing crops at the right edge.
    const fitOverviewPos = (w: number, h: number) => {
      const aspect = Math.max(0.4, w / Math.max(1, h));
      const fitFactor = aspect >= 1.25 ? 1.18 : aspect >= 1 ? 1.55 : 1.95;
      const widthFactor = w < 420 ? 1.22 : w < 560 ? 1.1 : 1;
      return OVERVIEW_POS.clone().multiplyScalar(fitFactor * widthFactor);
    };
    let overviewPos = fitOverviewPos(mount.clientWidth, mount.clientHeight);
    camera.position.copy(overviewPos);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.minDistance = 3.2;
    controls.maxDistance = 34;
    controls.minPolarAngle = 0.85;
    controls.maxPolarAngle = 1.5;
    // No auto-orbit: the operator drives the camera.
    controls.autoRotate = false;
    controls.target.copy(ORIGIN);

    // No real point lights — emissive materials + additive glow sprites
    // carry the look; a soft ambient keeps the dark faces readable.
    scene.add(new THREE.AmbientLight(0x8899bb, 2.0));

    const glowTex = makeGlowTexture();

    /* ----- core (NewsFlow) ----- */
    const coreGroup = new THREE.Group();
    scene.add(coreGroup);

    const coreUniforms = {
      uRim: { value: new THREE.Color(0x00f5ff) },
      uCore: { value: new THREE.Color(0x02060c) },
      uPulse: { value: 1 },
    };
    const coreMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.1, 2),
      new THREE.ShaderMaterial({
        uniforms: coreUniforms,
        vertexShader: `
          varying vec3 vN;
          varying vec3 vV;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vN = normalize(normalMatrix * normal);
            vV = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform vec3 uRim;
          uniform vec3 uCore;
          uniform float uPulse;
          varying vec3 vN;
          varying vec3 vV;
          void main() {
            float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4);
            vec3 col = mix(uCore, uRim, f) * (0.7 + 0.5 * f) * uPulse;
            col += uRim * f * 1.7 * uPulse;
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    coreGroup.add(coreMesh);

    const innerMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.68, 1),
      new THREE.MeshBasicMaterial({
        color: 0x00f5ff,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        wireframe: true,
      }),
    );
    coreGroup.add(innerMesh);

    const coreRingGeo = new THREE.TorusGeometry(1.7, 0.015, 8, 128);
    const coreRingMat = new THREE.MeshBasicMaterial({
      color: 0x00f5ff,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const coreRing1 = new THREE.Mesh(coreRingGeo, coreRingMat);
    coreRing1.rotation.set(1.15, 0.2, 0);
    const coreRing2 = new THREE.Mesh(coreRingGeo, coreRingMat.clone());
    (coreRing2.material as THREE.MeshBasicMaterial).opacity = 0.35;
    coreRing2.rotation.set(0.4, 1.05, 0.3);
    coreGroup.add(coreRing1, coreRing2);

    const coreGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: 0x00f5ff,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    coreGlow.scale.setScalar(4.3);
    coreGroup.add(coreGlow);

    const coreLabelEl = document.createElement("div");
    coreLabelEl.className = "mc-node-label mc-core-label";
    const coreLabelTop = document.createElement("span");
    coreLabelTop.className = "mc-node-code";
    coreLabelTop.textContent = "CORE";
    const coreLabelBottom = document.createElement("span");
    coreLabelBottom.className = "mc-node-status";
    coreLabelEl.append(coreLabelTop, coreLabelBottom);
    const coreLabel = new CSS2DObject(coreLabelEl);
    coreLabel.position.set(0, -2.2, 0);
    coreGroup.add(coreLabel);

    /* ----- orbit rings ----- */
    const ringGroups = RING_DEFS.map((def) => {
      const g = new THREE.Group();
      g.rotation.x = def.tilt;
      scene.add(g);
      return g;
    });
    // Orbit path guides: both rings baked (with their tilt) into ONE
    // merged BufferGeometry — a single draw call for the rails.
    {
      const pts: THREE.Vector3[] = [];
      for (const def of RING_DEFS) {
        const ringPts: THREE.Vector3[] = [];
        for (let k = 0; k <= 96; k++) {
          const a = (k / 96) * Math.PI * 2;
          ringPts.push(
            new THREE.Vector3(Math.cos(a) * def.radius, 0, Math.sin(a) * def.radius).applyEuler(
              new THREE.Euler(def.tilt, 0, 0),
            ),
          );
        }
        for (let k = 0; k < 96; k++) {
          const a = ringPts[k];
          const b = ringPts[k + 1];
          if (a && b) pts.push(a, b);
        }
      }
      const guides = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: 0x00f5ff,
          transparent: true,
          opacity: 0.12,
          depthWrite: false,
        }),
      );
      scene.add(guides);
    }

    /* ----- holographic grid floor ----- */
    const grid = new THREE.PolarGridHelper(7.5, 12, 6, 72, 0x00f5ff, 0x0e5a66);
    grid.position.y = -2.3;
    const gridMat = grid.material as THREE.Material;
    gridMat.transparent = true;
    gridMat.opacity = 0.16;
    gridMat.depthWrite = false;
    scene.add(grid);

    /* ----- starfield ----- */
    const starCount = lowTier ? 1200 : 4000;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 26 + Math.random() * 60;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.cos(phi) * 0.7;
      starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({
        color: 0x9fdcff,
        size: 0.55,
        map: glowTex,
        transparent: true,
        opacity: 0.8,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    scene.add(stars);

    /* ----- beams + packets ----- */
    const beams = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    beams.frustumCulled = false;
    scene.add(beams);

    const selectedBeam = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0x00f5ff,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    selectedBeam.frustumCulled = false;
    selectedBeam.visible = false;
    scene.add(selectedBeam);

    const packets = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        size: 0.3,
        map: glowTex,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    packets.frustumCulled = false;
    scene.add(packets);

    /* ----- composer (desktop tier only) ----- */
    let composer: EffectComposer | null = null;
    if (!lowTier) {
      composer = new EffectComposer(renderer);
      composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      composer.addPass(new RenderPass(scene, camera));
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(mount.clientWidth, mount.clientHeight),
        0.65,
        0.35,
        0.85,
      );
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
    }

    /* ----- shared geometry ----- */
    // Status is a shape before it is a color: sphere / cube /
    // octahedron / icosahedron, swapped live when a node's state flips.
    const GEO_BY_STATE: Record<SceneNodeState, THREE.BufferGeometry> = {
      active: new THREE.IcosahedronGeometry(0.28, 3),
      paused: new THREE.BoxGeometry(0.44, 0.44, 0.44),
      failed: new THREE.OctahedronGeometry(0.4, 0),
      disabled: new THREE.IcosahedronGeometry(0.28, 0),
      // Pending: torus ring halo — a queued loop, distinct from every
      // solid shape. Running: dodecahedron — a bright faceted solid
      // that reads as energized next to the smooth active sphere.
      pending: new THREE.TorusGeometry(0.3, 0.11, 12, 28),
      running: new THREE.DodecahedronGeometry(0.36, 0),
    };
    const nodeRingGeo = new THREE.TorusGeometry(0.44, 0.009, 8, 64);
    const arcGeo = new THREE.TorusGeometry(0.54, 0.02, 8, 72);

    const nodeMap = new Map<string, Node3D>();
    const hitMeshes: THREE.Object3D[] = [];
    let beamCount = -1;

    const buildBeamBuffers = (count: number) => {
      beams.geometry.dispose();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3));
      geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3));
      beams.geometry = geo;
      packets.geometry.dispose();
      const pgeo = new THREE.BufferGeometry();
      pgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      pgeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      packets.geometry = pgeo;
      selectedBeam.geometry.dispose();
      selectedBeam.geometry = new THREE.BufferGeometry().setFromPoints([ORIGIN, ORIGIN]);
      beamCount = count;
    };

    const disposeNode = (n: Node3D) => {
      n.group.removeFromParent();
      n.labelEl.remove();
      (n.core.material as THREE.Material).dispose();
      (n.wire.material as THREE.Material).dispose();
      (n.ringMesh.material as THREE.Material).dispose();
      (n.arc.material as THREE.Material).dispose();
      (n.glow.material as THREE.Material).dispose();
      const hi = hitMeshes.indexOf(n.core);
      if (hi >= 0) hitMeshes.splice(hi, 1);
    };

    const createNode = (sn: SceneNode, ringIndex: number, ordinal: number, ringSize: number): Node3D => {
      const group = new THREE.Group();
      const hex = STATE_HEX[sn.state];
      const color = new THREE.Color(hex);
      const geo = GEO_BY_STATE[sn.state];

      const core = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: 0x0b1118,
          emissive: color,
          emissiveIntensity: 1.2,
          roughness: 0.35,
          metalness: 0.1,
          flatShading: true,
        }),
      );
      core.userData["nodeId"] = sn.id;

      const wire = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color,
          wireframe: true,
          transparent: true,
          opacity: 0.38,
        }),
      );
      wire.scale.setScalar(1.12);

      const ringMesh = new THREE.Mesh(
        nodeRingGeo,
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      ringMesh.rotation.set(1.25 + Math.random() * 0.5, 0.3, 0);

      // Countdown arc: a torus whose shader fills clockwise from the
      // top as the next run approaches (uv.x runs around the ring).
      const arc = new THREE.Mesh(
        arcGeo,
        new THREE.ShaderMaterial({
          uniforms: {
            uFrac: { value: 0 },
            uColor: { value: color.clone() },
            uOpacity: { value: 0.95 },
          },
          vertexShader: `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
          fragmentShader: `
            uniform float uFrac;
            uniform vec3 uColor;
            uniform float uOpacity;
            varying vec2 vUv;
            void main() {
              float a = 1.0 - vUv.x;
              float on = step(a, uFrac);
              float head = smoothstep(0.035, 0.0, abs(a - uFrac)) * step(0.001, uFrac) * step(uFrac, 0.999);
              vec3 col = uColor * (0.5 + 0.9 * on) + uColor * head * 1.6;
              gl_FragColor = vec4(col, uOpacity * (0.22 + 0.78 * on));
            }`,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      arc.rotation.z = Math.PI / 2;
      arc.visible = false;

      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          color,
          transparent: true,
          opacity: sn.state === "disabled" ? 0.18 : 0.32,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      glow.scale.setScalar(1.3);

      const labelEl = document.createElement("div");
      labelEl.className = "mc-node-label";
      const labelNext = document.createElement("span");
      labelNext.className = "mc-node-next";
      labelNext.textContent = "NEXT";
      const labelCode = document.createElement("span");
      labelCode.className = "mc-node-code";
      const labelStatus = document.createElement("span");
      labelStatus.className = "mc-node-status";
      const labelRun = document.createElement("span");
      labelRun.className = "mc-node-nextrun";
      labelEl.append(labelNext, labelCode, labelStatus, labelRun);
      const label = new CSS2DObject(labelEl);
      label.position.set(0, 0.78, 0);

      group.add(core, wire, ringMesh, arc, glow, label);
      const parent = ringGroups[ringIndex] ?? ringGroups[0];
      if (parent) parent.add(group);
      hitMeshes.push(core);

      return {
        id: sn.id,
        group,
        core: core as Node3D["core"],
        wire: wire as Node3D["wire"],
        ringMesh: ringMesh as Node3D["ringMesh"],
        arc: arc as Node3D["arc"],
        glow,
        labelObj: label,
        labelEl,
        labelCode,
        labelStatus,
        labelNext,
        labelRun,
        ringIndex,
        angle: (ordinal / Math.max(1, ringSize)) * Math.PI * 2 + ringIndex * 0.9,
        phase: Math.random() * Math.PI * 2,
        state: sn.state,
        isNext: sn.isNext,
        nextRunMs: sn.nextRunMs,
        cdText: "",
        scaleCur: 1,
      };
    };

    /* ----- interaction state ----- */
    let hoveredId: string | null = null;
    let currentSelected: string | null = null;
    let tween: CamTween | null = null;
    let pointerOver = false;
    let downX = 0;
    let downY = 0;
    // Ingest pulse: beams + core flare when a fresh snapshot lands.
    let beamPulse = 0;
    let lastPulseKey: string | null = null;

    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const tmpV = new THREE.Vector3();

    /* Scratch for the throttled label legibility pass. */
    type LabelCand = { n: Node3D; x: number; y: number; z: number; dist: number; prio: number };
    const labelCands: LabelCand[] = [];
    const projV = new THREE.Vector3();

    const setRayFromEvent = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointerNdc.x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      pointerNdc.y = -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);
    };

    const pickNode = (e: PointerEvent): string | null => {
      setRayFromEvent(e);
      const hits = raycaster.intersectObjects(hitMeshes, false);
      const first = hits[0];
      if (!first) return null;
      const id = first.object.userData["nodeId"];
      return typeof id === "string" ? id : null;
    };

    const focusCameraOn = (n: Node3D | null, instant: boolean) => {
      const toTgt = n ? n.group.getWorldPosition(new THREE.Vector3()) : ORIGIN.clone();
      let toPos: THREE.Vector3;
      if (n) {
        const outward = toTgt.clone().setY(0);
        if (outward.lengthSq() < 0.001) outward.set(0, 0, 1);
        outward.normalize();
        toPos = toTgt.clone().add(outward.multiplyScalar(4.1)).add(new THREE.Vector3(0, 1.55, 0));
      } else {
        toPos = overviewPos.clone();
      }
      if (instant) {
        camera.position.copy(toPos);
        controls.target.copy(toTgt);
        tween = null;
        return;
      }
      tween = {
        t: 0,
        dur: 0.6,
        fromPos: camera.position.clone(),
        toPos,
        fromTgt: controls.target.clone(),
        toTgt,
      };
      controls.enabled = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return; // drag, not tap
      const id = pickNode(e);
      if (id) {
        onSelectRef.current(id === currentSelected ? null : id);
      } else {
        // Tapping empty space (or the core) returns to the overview.
        setRayFromEvent(e);
        const coreHit = raycaster.intersectObject(coreMesh, false).length > 0;
        if (coreHit || currentSelected) onSelectRef.current(null);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      const id = pickNode(e);
      if (id !== hoveredId) {
        hoveredId = id;
        onHoverRef.current?.(id);
      }
      renderer.domElement.style.cursor = hoveredId ? "pointer" : "";
    };
    const onPointerEnter = () => {
      pointerOver = true;
    };
    const onPointerLeave = () => {
      pointerOver = false;
      if (hoveredId !== null) {
        hoveredId = null;
        onHoverRef.current?.(null);
      }
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    mount.addEventListener("pointerenter", onPointerEnter);
    mount.addEventListener("pointerleave", onPointerLeave);

    /* ----- sync from React props ----- */
    const sync = (d: SyncData) => {
      // A changed pulse key = a fresh snapshot landed: flare the beams.
      if (d.pulseKey && d.pulseKey !== lastPulseKey) {
        lastPulseKey = d.pulseKey;
        beamPulse = 1;
      }
      // Structural changes: ring assignment by alternating index.
      const ringCounts = [0, 0];
      for (let i = 0; i < d.nodes.length; i++) ringCounts[i % 2] = (ringCounts[i % 2] ?? 0) + 1;
      const seen = new Set<string>();
      const ordinals = [0, 0];
      for (let i = 0; i < d.nodes.length; i++) {
        const sn = d.nodes[i];
        if (!sn) continue;
        seen.add(sn.id);
        const ringIndex = i % 2;
        const existing = nodeMap.get(sn.id);
        if (!existing) {
          const ordinal = ordinals[ringIndex] ?? 0;
          ordinals[ringIndex] = ordinal + 1;
          nodeMap.set(sn.id, createNode(sn, ringIndex, ordinal, ringCounts[ringIndex] ?? 1));
        } else {
          ordinals[ringIndex] = (ordinals[ringIndex] ?? 0) + 1;
          if (existing.ringIndex !== ringIndex) {
            existing.ringIndex = ringIndex;
            const parent = ringGroups[ringIndex] ?? ringGroups[0];
            if (parent) parent.add(existing.group);
          }
        }
      }
      for (const [id, n] of [...nodeMap.entries()]) {
        if (!seen.has(id)) {
          disposeNode(n);
          nodeMap.delete(id);
        }
      }
      if (beamCount !== nodeMap.size) buildBeamBuffers(nodeMap.size);

      // Per-node visuals from latest data.
      const beamColorAttr = beams.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
      let bi = 0;
      for (const sn of d.nodes) {
        const n = nodeMap.get(sn.id);
        if (!n) continue;
        n.state = sn.state;
        n.isNext = sn.isNext;
        n.nextRunMs = sn.nextRunMs;
        const color = new THREE.Color(STATE_HEX[sn.state]);
        const geo = GEO_BY_STATE[sn.state];
        if (n.core.geometry !== geo) {
          n.core.geometry = geo;
          n.wire.geometry = geo;
          // flatShading normals are baked per-geometry: recompute them
          // for the swapped shape, or reflections smear across faces.
          geo.computeVertexNormals();
        }
        (n.core.material as THREE.MeshStandardMaterial).emissive.copy(color);
        (n.wire.material as THREE.MeshBasicMaterial).color.copy(color);
        (n.ringMesh.material as THREE.MeshBasicMaterial).color.copy(color);
        (n.glow.material as THREE.SpriteMaterial).color.copy(color);
        const arcUniforms = (n.arc.material as THREE.ShaderMaterial).uniforms;
        const uColor = arcUniforms["uColor"];
        if (uColor) (uColor.value as THREE.Color).copy(color);
        const uOpacity = arcUniforms["uOpacity"];
        if (uOpacity) uOpacity.value = sn.state === "disabled" ? 0.5 : 0.95;
        n.labelCode.textContent = sn.code;
        n.labelCode.style.color = `#${color.getHexString()}`;
        n.labelStatus.textContent = STATE_WORD[sn.state];
        n.labelStatus.style.color = `#${color.getHexString()}`;
        n.labelNext.style.display = sn.isNext ? "block" : "none";
        n.labelEl.style.borderColor = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, 0.45)`;
        n.labelEl.classList.toggle("mc-node-label-sel", sn.id === d.selectedId);
        if (beamColorAttr) {
          // Bright at the core, fading toward the node (vertex-color gradient).
          beamColorAttr.setXYZ(bi * 2, color.r * 0.85, color.g * 0.85, color.b * 0.85);
          beamColorAttr.setXYZ(bi * 2 + 1, color.r * 0.06, color.g * 0.06, color.b * 0.06);
          beamColorAttr.needsUpdate = true;
        }
        bi++;
      }
      const packetsColorAttr = packets.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
      if (packetsColorAttr) {
        let pi = 0;
        for (const sn of d.nodes) {
          const color = new THREE.Color(STATE_HEX[sn.state]);
          packetsColorAttr.setXYZ(pi, color.r, color.g, color.b);
          pi++;
        }
        packetsColorAttr.needsUpdate = true;
      }

      // Core follows NewsFlow's own status (set by the caller).
      const coreColor = new THREE.Color(STATE_HEX[d.coreState]);
      coreUniforms.uRim.value.copy(coreColor);
      (innerMesh.material as THREE.MeshBasicMaterial).color.copy(coreColor);
      (coreRing1.material as THREE.MeshBasicMaterial).color.copy(coreColor);
      (coreRing2.material as THREE.MeshBasicMaterial).color.copy(coreColor);
      (coreGlow.material as THREE.SpriteMaterial).color.copy(coreColor);
      coreLabelBottom.textContent = d.coreLabel;
      coreLabelBottom.style.color = `#${coreColor.getHexString()}`;
      coreLabelEl.style.borderColor = `rgba(${Math.round(coreColor.r * 255)}, ${Math.round(coreColor.g * 255)}, ${Math.round(coreColor.b * 255)}, 0.5)`;

      // Selection transitions drive the camera.
      if (d.selectedId !== currentSelected) {
        const target = d.selectedId ? nodeMap.get(d.selectedId) : undefined;
        currentSelected = d.selectedId;
        focusCameraOn(target ?? null, !d.animate);
      }
    };
    apiRef.current = { sync };
    sync(dataRef.current);

    /* ----- resize ----- */
    const resize = () => {
      const w = Math.max(1, mount.clientWidth);
      const h = Math.max(1, mount.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      labelRenderer.setSize(w, h);
      if (composer) composer.setSize(w, h);
      // Keep the whole orbit framed across rotation/resize: while the
      // operator isn't inspecting a node, re-apply the fitted overview.
      overviewPos = fitOverviewPos(w, h);
      if (!currentSelected && !tween) camera.position.copy(overviewPos);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    /* ----- render loop ----- */
    let raf = 0;
    let lastT = performance.now();
    let elapsed = 0;
    let labelTimer = 1; // run the first label pass immediately
    // Adaptive quality: sustained <45fps steps the scene down
    // (bloom → pixel ratio → 2D fallback) instead of janking forever.
    let fpsWindowT = 0;
    let fpsFrames = 0;
    let badWindows = 0;
    let qualityTier = composer ? 0 : 1;
    let liteFallbackFired = false;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      const d = dataRef.current;
      if (d.animate) elapsed += dt;
      const t = elapsed;
      const nowMs = Date.now();

      // Adaptive quality check, once per second after a warm-up.
      if (d.animate && elapsed > 3) {
        fpsWindowT += dt;
        fpsFrames++;
        if (fpsWindowT >= 1) {
          const fps = fpsFrames / fpsWindowT;
          fpsWindowT = 0;
          fpsFrames = 0;
          if (fps < 45) {
            badWindows++;
            if (badWindows >= 2) {
              badWindows = 0;
              if (qualityTier === 0 && composer) {
                composer = null;
                qualityTier = 1;
              } else if (qualityTier === 1) {
                renderer.setPixelRatio(1.25);
                renderer.setSize(Math.max(1, mount.clientWidth), Math.max(1, mount.clientHeight), false);
                qualityTier = 2;
              } else if (!liteFallbackFired) {
                liteFallbackFired = true;
                onFailRef.current();
              }
            }
          } else {
            badWindows = 0;
          }
        }
      }

      // Orbit motion eases to a crawl under the pointer / while inspecting.
      const frozen = currentSelected !== null || pointerOver;
      const speedScale = frozen ? 0.12 : 1;
      beamPulse = Math.max(0, beamPulse - dt * 0.7);
      (beams.material as THREE.LineBasicMaterial).opacity = 0.3 + beamPulse * 0.5;
      (packets.material as THREE.PointsMaterial).opacity = 0.95;

      let idx = 0;
      const beamPosAttr = beams.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      const packetPosAttr = packets.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      for (const sn of d.nodes) {
        const n = nodeMap.get(sn.id);
        if (!n) continue;
        const def = RING_DEFS[n.ringIndex] ?? RING_DEFS[0];
        if (def && d.animate) n.angle += def.speed * dt * speedScale;
        const radius = def ? def.radius : 3.2;
        n.group.position.set(Math.cos(n.angle) * radius, 0, Math.sin(n.angle) * radius);
        n.group.getWorldPosition(tmpV);

        // Status pulse patterns (double-encoded with color for clarity).
        const coreMat = n.core.material as THREE.MeshStandardMaterial;
        const glowMat = n.glow.material as THREE.SpriteMaterial;
        const ringMat = n.ringMesh.material as THREE.MeshBasicMaterial;
        let intensity = 1.2;
        let glowOpacity = 0.32;
        if (d.animate) {
          if (n.state === "active") {
            intensity = 1.15 + 0.2 * Math.sin(t * 2 + n.phase);
            glowOpacity = 0.32 + 0.07 * Math.sin(t * 2 + n.phase);
          } else if (n.state === "pending") {
            // Queued: steady teal breathing — waiting, not executing.
            intensity = 0.95 + 0.35 * Math.sin(t * 1.6 + n.phase);
            glowOpacity = 0.3 + 0.1 * Math.sin(t * 1.6 + n.phase);
          } else if (n.state === "running") {
            // Executing now: fast bright heartbeat, unmistakably live.
            intensity = 1.7 + 0.65 * Math.sin(t * Math.PI * 3 + n.phase);
            glowOpacity = 0.5 + 0.2 * Math.sin(t * Math.PI * 3 + n.phase);
          } else if (n.state === "paused") {
            intensity = 0.8 + 0.45 * Math.sin(t * Math.PI + n.phase);
            glowOpacity = 0.24 + 0.1 * Math.sin(t * Math.PI + n.phase);
          } else if (n.state === "failed") {
            intensity = 1.2 + 0.8 * Math.sin(t * Math.PI * 4 + n.phase);
            glowOpacity = 0.38 + 0.18 * Math.sin(t * Math.PI * 4 + n.phase);
          } else {
            intensity = 0.35;
            glowOpacity = 0.16;
          }
        } else if (n.state === "disabled") {
          intensity = 0.35;
          glowOpacity = 0.16;
        } else if (n.state === "running") {
          intensity = 1.8;
          glowOpacity = 0.5;
        }
        const isSel = sn.id === currentSelected;
        const isHover = sn.id === hoveredId || sn.id === d.highlightId;
        if (isSel) intensity += 0.6;
        coreMat.emissiveIntensity = intensity;
        glowMat.opacity =
          (n.state === "disabled" && !isSel ? 0.16 : glowOpacity) + beamPulse * 0.3;
        glowMat.needsUpdate = true;
        ringMat.opacity = isSel ? 1 : isHover ? 0.95 : 0.7;
        if ((n.state === "failed" || n.state === "running") && d.animate) {
          const speed = n.state === "running" ? Math.PI * 3 : Math.PI * 4;
          const amp = n.state === "running" ? 0.22 : 0.16;
          const rp = 1 + amp * (0.5 + 0.5 * Math.sin(t * speed + n.phase));
          n.ringMesh.scale.setScalar(rp);
        } else if (!d.animate || (n.state !== "failed" && n.state !== "running")) {
          n.ringMesh.scale.setScalar(1);
        }

        // Countdown arc fill (hidden when the next run is unknown).
        const frac = runFrac(sn, nowMs);
        n.arc.visible = frac !== null;
        if (frac !== null) {
          const u = (n.arc.material as THREE.ShaderMaterial).uniforms["uFrac"];
          if (u) u.value = frac;
        }

        const targetScale = isSel ? 1.35 : isHover ? 1.25 : 1;
        n.scaleCur += (targetScale - n.scaleCur) * Math.min(1, dt * 10);
        n.group.scale.setScalar(n.scaleCur);
        if (d.animate) {
          n.ringMesh.rotation.z += dt * 0.7;
          n.wire.rotation.y += dt * 0.25;
        }
        n.glow.scale.setScalar(isSel ? 1.7 : 1.3);

        // Stash this label's world position for the legibility pass below.
        n.labelObj.getWorldPosition(projV);
        labelCands.push({
          n,
          x: projV.x,
          y: projV.y,
          z: projV.z,
          dist: camera.position.distanceTo(projV),
          prio: isSel ? 0 : isHover ? 1 : n.state === "failed" ? 2 : n.state === "running" ? 3 : n.isNext ? 4 : n.state === "pending" ? 5 : n.state === "paused" ? 6 : n.state === "active" ? 7 : 8,
        });

        if (beamPosAttr) {
          beamPosAttr.setXYZ(idx * 2, 0, 0, 0);
          beamPosAttr.setXYZ(idx * 2 + 1, tmpV.x, tmpV.y, tmpV.z);
        }
        if (packetPosAttr) {
          if (n.state === "active" || n.state === "running" || isSel) {
            const speed = n.state === "running" ? 0.65 : 0.3;
            const pt = (t * speed + idx * 0.37 + n.phase * 0.05) % 1;
            packetPosAttr.setXYZ(idx, tmpV.x * pt, tmpV.y * pt, tmpV.z * pt);
          } else {
            packetPosAttr.setXYZ(idx, 0, -999, 0);
          }
        }
        if (isSel) {
          selectedBeam.visible = true;
          const attr = selectedBeam.geometry.getAttribute("position") as THREE.BufferAttribute;
          attr.setXYZ(0, 0, 0, 0);
          attr.setXYZ(1, tmpV.x, tmpV.y, tmpV.z);
          attr.needsUpdate = true;
          // Keep the inspect camera locked onto the (slowly drifting) node.
          if (!tween) controls.target.lerp(tmpV, Math.min(1, dt * 3));
        }
        idx++;
      }
      if (beamPosAttr) beamPosAttr.needsUpdate = true;
      if (packetPosAttr) packetPosAttr.needsUpdate = true;
      if (!d.nodes.some((s) => s.id === currentSelected)) selectedBeam.visible = false;

      /* ----- label legibility pass (~5Hz, not every frame) -----
         With 16 nodes on two rings, chips constantly cross each other
         and the core. Far-side chips fade with depth; a chip that would
         collide with a higher-priority one (selected > hovered > failed
         > next > paused > active > disabled, nearer first) hides until
         the orbit separates them again. The core chip always keeps its
         slot below the core. Countdown text refreshes on the same tick. */
      labelTimer += dt;
      if (labelTimer >= 0.2 && labelCands.length > 0) {
        labelTimer = 0;
        let nearD = Infinity;
        let farD = -Infinity;
        for (const c of labelCands) {
          if (c.dist < nearD) nearD = c.dist;
          if (c.dist > farD) farD = c.dist;
        }
        const span = Math.max(0.001, farD - nearD);
        const viewW = Math.max(1, mount.clientWidth);
        const viewH = Math.max(1, mount.clientHeight);
        type Rect = { x0: number; y0: number; x1: number; y1: number };
        const placed: Rect[] = [];
        projV.set(0, -2.2, 0).project(camera);
        if (projV.z < 1) {
          const cx = (projV.x * 0.5 + 0.5) * viewW;
          const cy = (-projV.y * 0.5 + 0.5) * viewH;
          placed.push({ x0: cx - 42, y0: cy - 18, x1: cx + 42, y1: cy + 18 });
        }
        labelCands.sort((a, b) => a.prio - b.prio || a.dist - b.dist);
        for (const c of labelCands) {
          const cd =
            c.n.state === "running" ? "LIVE" : countdownText(c.n.nextRunMs, nowMs);
          if (cd !== c.n.cdText) {
            c.n.cdText = cd;
            c.n.labelRun.textContent =
              cd === "LIVE" ? "● LIVE" : cd ? (cd === "DUE" ? "DUE" : `IN ${cd}`) : "";
          }
          const depthT = THREE.MathUtils.clamp((c.dist - nearD) / span, 0, 1);
          let op = 1 - depthT * 0.55;
          projV.set(c.x, c.y, c.z).project(camera);
          if (projV.z > 1) {
            c.n.labelEl.style.opacity = "0";
            continue;
          }
          const sx = (projV.x * 0.5 + 0.5) * viewW;
          const sy = (-projV.y * 0.5 + 0.5) * viewH;
          const rect: Rect = { x0: sx - 30, y0: sy - 18, x1: sx + 30, y1: sy + 18 };
          const hit = placed.some(
            (r) => rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0,
          );
          if (hit && c.prio > 1) op = 0;
          else placed.push(rect);
          c.n.labelEl.style.opacity = op.toFixed(3);
        }
      }
      labelCands.length = 0;

      // Core life: pulse + counter-rotating rings (+ ingest flare).
      const pulse = d.animate ? 1 + 0.07 * Math.sin(t * Math.PI * 1.6) : 1;
      innerMesh.scale.setScalar(pulse);
      coreUniforms.uPulse.value =
        (d.animate ? 0.95 + 0.18 * Math.sin(t * Math.PI * 1.6) : 1) + beamPulse * 0.7;
      if (d.animate) {
        coreRing1.rotation.z += dt * 0.2;
        coreRing2.rotation.z -= dt * 0.14;
        coreMesh.rotation.y += dt * 0.1;
        stars.rotation.y += dt * 0.004;
      }
      coreGlow.scale.setScalar(4.3 + (d.animate ? 0.25 * Math.sin(t * Math.PI * 1.6) : 0) + beamPulse * 0.8);

      // Camera tween (600ms ease-out) then hand control back.
      if (tween) {
        tween.t += dt / tween.dur;
        const k = easeOutCubic(Math.min(1, tween.t));
        camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
        controls.target.lerpVectors(tween.fromTgt, tween.toTgt, k);
        if (tween.t >= 1) {
          tween = null;
          controls.enabled = true;
        }
      }
      controls.update();

      if (composer) composer.render();
      else renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      mount.removeEventListener("pointerenter", onPointerEnter);
      mount.removeEventListener("pointerleave", onPointerLeave);
      controls.dispose();
      for (const n of nodeMap.values()) disposeNode(n);
      nodeMap.clear();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      glowTex.dispose();
      if (composer) composer.dispose();
      renderer.dispose();
      labelRenderer.domElement.remove();
      renderer.domElement.remove();
      apiRef.current = null;
    };
    // Mount once; all later data flows through apiRef.sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push every render's props into the scene (idempotent).
  useEffect(() => {
    apiRef.current?.sync(dataRef.current);
  });

  return (
    <div
      ref={mountRef}
      className="mc-stage3d relative aspect-square w-full overflow-hidden"
      role="img"
      aria-label="3D orbital view of the agent fleet around the NewsFlow core. Drag to orbit, scroll to zoom, tap a node to inspect it. The fleet list below provides the same selection by keyboard."
    >
      {/* vignette for cockpit depth */}
      <div className="mc-vignette pointer-events-none absolute inset-0 z-10" aria-hidden />
      <span className="pointer-events-none absolute bottom-2 left-3 z-10 font-mono text-[10px] tracking-widest text-[#5b6b80]">
        DHAKA {hudTime}
      </span>
      <span className="pointer-events-none absolute bottom-2 right-3 z-10 font-mono text-[10px] tracking-widest text-[#5b6b80]">
        NODES {nodes.length}
      </span>
      <span className="pointer-events-none absolute left-1/2 top-2 z-10 max-w-[86%] -translate-x-1/2 truncate font-mono text-[10px] tracking-[0.2em] text-[#5b6b80]">
        {trackingLabel}
      </span>
      <span className="pointer-events-none absolute bottom-2 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap font-mono text-[9px] tracking-[0.18em] text-[#41505f] min-[480px]:block">
        DRAG TO ORBIT · TAP A NODE
      </span>
    </div>
  );
}
