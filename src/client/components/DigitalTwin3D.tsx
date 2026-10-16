import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import type { TileId, WasteId, WasteStatus } from '../../shared/types';
import { VALID_TILES, VALID_WASTE_IDS, getTileGridCoords } from '../../shared/scenario';
import type { ProjectedFrameState } from '../../shared/frameProjector';

type WorkerLocation = TileId | 'DISPOSAL_BIN' | 'HOME_PAD';

export interface DigitalTwin3DProps {
  projected: ProjectedFrameState;
  selectedWasteId: WasteId | null;
  onSelectWasteId: (wasteId: WasteId | null) => void;
  onWebGLFailure: (reason: string) => void;
  snapSignal: number;
  activeExperimentLabel?: string;
}

const TILE_SPACING = 2.15;
const GRID_OFFSET = ((4 - 1) * TILE_SPACING) / 2;

const DISPOSAL_BIN_POS = new THREE.Vector3(4.95, 0, 1.35);
const TRUCK_POS = new THREE.Vector3(5.35, 0, 4.15);
const WORKER_HOME_POS = new THREE.Vector3(-4.65, 0, 2.15);

function getTileWorldPos(tileId: TileId): THREE.Vector3 {
  const coord = getTileGridCoords(tileId);
  const x = coord.col * TILE_SPACING - GRID_OFFSET;
  const z = coord.row * TILE_SPACING - GRID_OFFSET;
  return new THREE.Vector3(x, 0, z);
}

function getLocationWorldPos(loc: WorkerLocation): THREE.Vector3 {
  if (loc === 'HOME_PAD') {
    return WORKER_HOME_POS.clone();
  }
  if (loc === 'DISPOSAL_BIN') {
    return new THREE.Vector3(DISPOSAL_BIN_POS.x - 1.35, 0, DISPOSAL_BIN_POS.z);
  }
  return getTileWorldPos(loc);
}

function getDisposedSlotWorldPos(wasteId: WasteId): THREE.Vector3 {
  const idx = VALID_WASTE_IDS.indexOf(wasteId);
  const row = Math.floor(idx / 2);
  const col = idx % 2;
  return new THREE.Vector3(
    DISPOSAL_BIN_POS.x - 0.28 + col * 0.56,
    0.48,
    DISPOSAL_BIN_POS.z - 0.58 + row * 0.39
  );
}

function createTileLabelTexture(tileId: TileId, isInitialWaste: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // Stylized stone plaza paver background
  ctx.fillStyle = isInitialWaste ? '#283548' : '#233042';
  ctx.fillRect(0, 0, 256, 256);

  // Subtle internal stone paver joint lines
  ctx.strokeStyle = '#1E293B';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(128, 12);
  ctx.lineTo(128, 244);
  ctx.moveTo(12, 128);
  ctx.lineTo(244, 128);
  ctx.stroke();

  // Outer paver bevel frame
  ctx.strokeStyle = isInitialWaste ? '#475569' : '#334155';
  ctx.lineWidth = 8;
  ctx.strokeRect(8, 8, 240, 240);

  // Subtle corner ticks
  ctx.strokeStyle = isInitialWaste ? '#60A5FA' : '#475569';
  ctx.lineWidth = 4;
  const tick = 22;
  ctx.beginPath();
  ctx.moveTo(14, 14 + tick);
  ctx.lineTo(14, 14);
  ctx.lineTo(14 + tick, 14);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(242 - tick, 242);
  ctx.lineTo(242, 242);
  ctx.lineTo(242, 242 - tick);
  ctx.stroke();

  ctx.fillStyle = '#94A3B8';
  ctx.font = '700 26px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(tileId, 24, 22);

  if (isInitialWaste) {
    ctx.fillStyle = '#64748B';
    ctx.font = '600 17px "JetBrains Mono", monospace';
    ctx.fillText('PUBLIC·ZONE', 24, 210);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createBuildingFacadeTexture(
  rows: number,
  cols: number,
  baseHex: string,
  warmRatio = 0.65
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 256, 256);

  const padX = 22;
  const padY = 24;
  const cellW = (256 - padX * 2) / cols;
  const cellH = (256 - padY * 2) / rows;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hash = ((r * 7 + c * 13) % 10) / 10;
      if (hash < warmRatio) {
        ctx.fillStyle = hash < 0.35 ? '#FDE68A' : '#F59E0B';
      } else if (hash < 0.82) {
        ctx.fillStyle = '#38BDF8';
      } else {
        ctx.fillStyle = '#0F172A';
      }
      ctx.fillRect(
        padX + c * cellW + 5,
        padY + r * cellH + 5,
        Math.max(8, cellW - 10),
        Math.max(8, cellH - 10)
      );
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createWasteBadgeTexture(
  wasteId: WasteId,
  status: WasteStatus,
  isSelected: boolean,
  isGhost = false
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 280;
  canvas.height = 88;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, 280, 88);

  const shortId = `#${wasteId.replace('W0', 'W')}`;
  let bg = '#0F172A';
  let border = '#F59E0B';
  let badgeText = `${shortId} · PUBLIC`;
  let dotColor = '#F59E0B';

  if (isGhost) {
    bg = '#0F172A';
    border = '#22D3EE';
    badgeText = `${shortId} · GHOST`;
    dotColor = '#22D3EE';
  } else if (status === 'CARRIED') {
    border = '#38BDF8';
    badgeText = `${shortId} · CARRIED`;
    dotColor = '#38BDF8';
  } else if (status === 'DISPOSED') {
    border = '#10B981';
    badgeText = `${shortId} · BIN`;
    dotColor = '#10B981';
  }

  if (isSelected) {
    bg = '#1E293B';
  }

  const r = 18;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(8, 10, 264, 68, r);
  ctx.fill();

  ctx.lineWidth = isSelected ? 6 : 3.5;
  ctx.strokeStyle = isSelected ? '#F8FAFC' : border;
  ctx.stroke();

  ctx.fillStyle = dotColor;
  ctx.beginPath();
  ctx.arc(36, 44, 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#F8FAFC';
  ctx.font = '700 25px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(badgeText, 54, 45);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

interface WasteVisualNode {
  group: THREE.Group;
  bagMesh: THREE.Mesh;
  knotMesh: THREE.Mesh;
  collarMesh: THREE.Mesh;
  badgeSprite: THREE.Sprite;
  badgeMaterial: THREE.SpriteMaterial;
  selectionRing: THREE.Mesh;
  targetPos: THREE.Vector3;
  targetScale: number;
  ghostGroup: THREE.Group;
  lastBadgeKey: string;
}

export const DigitalTwin3D: React.FC<DigitalTwin3DProps> = ({
  projected,
  selectedWasteId,
  onSelectWasteId,
  onWebGLFailure,
  snapSignal,
  activeExperimentLabel,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [hoveredWasteId, setHoveredWasteId] = useState<WasteId | null>(null);

  // Refs for mutable access inside requestAnimationFrame & event handlers
  const projectedRef = useRef<ProjectedFrameState>(projected);
  projectedRef.current = projected;

  const selectedWasteRef = useRef<WasteId | null>(selectedWasteId);
  selectedWasteRef.current = selectedWasteId;

  const onSelectWasteRef = useRef(onSelectWasteId);
  onSelectWasteRef.current = onSelectWasteId;

  const activeExperimentLabelRef = useRef<string | undefined>(activeExperimentLabel);
  activeExperimentLabelRef.current = activeExperimentLabel;

  const shouldSnapRef = useRef<boolean>(true);
  const prevSnapSignalRef = useRef<number>(snapSignal);
  const prevFrameIndexRef = useRef<number>(projected.frameIndex);

  if (
    snapSignal !== prevSnapSignalRef.current ||
    Math.abs(projected.frameIndex - prevFrameIndexRef.current) > 1
  ) {
    shouldSnapRef.current = true;
    prevSnapSignalRef.current = snapSignal;
  }
  prevFrameIndexRef.current = projected.frameIndex;

  const cameraResetRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    // 1. Check WebGL 2 support (AT-21 Fail-Closed to 2D Fallback)
    const probeCanvas = document.createElement('canvas');
    const gl2 = probeCanvas.getContext('webgl2');
    if (!gl2) {
      onWebGLFailure('WebGL 2 context is unavailable on this device/browser.');
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      onWebGLFailure(err instanceof Error ? err.message : 'Failed to construct WebGLRenderer.');
      return;
    }

    const width = Math.max(container.clientWidth, 320);
    const height = Math.max(container.clientHeight, 320);
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      onWebGLFailure('WebGL context lost during runtime.');
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost, false);

    // 2. Scene & Orthographic Isometric Camera
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0B101B');

    const frustumSize = 11.8;
    const aspect = width / height;
    const camera = new THREE.OrthographicCamera(
      (-frustumSize * aspect) / 2,
      (frustumSize * aspect) / 2,
      frustumSize / 2,
      -frustumSize / 2,
      0.1,
      100
    );

    const defaultCamPos = new THREE.Vector3(12.2, 12.8, 12.2);
    const defaultTarget = new THREE.Vector3(0.35, 0.15, 0.45);
    camera.position.copy(defaultCamPos);
    camera.lookAt(defaultTarget);

    const controls = new MapControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enableRotate = true;
    controls.minZoom = 0.65;
    controls.maxZoom = 2.4;
    controls.maxPolarAngle = Math.PI / 2.5;
    controls.minPolarAngle = Math.PI / 5;
    controls.target.copy(defaultTarget);
    controls.update();

    cameraResetRef.current = () => {
      camera.position.copy(defaultCamPos);
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      controls.target.copy(defaultTarget);
      controls.update();
    };

    // 3. Lighting (Vibrant Stylized City Diorama Rig)
    const hemiLight = new THREE.HemisphereLight('#BAE6FD', '#1E293B', 0.85);
    scene.add(hemiLight);

    const ambientLight = new THREE.AmbientLight('#E2E8F0', 1.15);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight('#FFFBEB', 2.2);
    dirLight.position.set(11, 19, 9);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.camera.near = 2;
    dirLight.shadow.camera.far = 42;
    const d = 11.5;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    scene.add(dirLight);

    const warmStreetFill = new THREE.DirectionalLight('#FDE047', 0.55);
    warmStreetFill.position.set(-10, 8, 10);
    scene.add(warmStreetFill);

    // 4. Stylized City Diorama Base, Asphalt Streets, Crosswalks & Lush Park Strips
    const cityFoundation = new THREE.Mesh(
      new THREE.BoxGeometry(16.8, 0.36, 15.6),
      new THREE.MeshStandardMaterial({ color: '#141C2B', roughness: 0.9 })
    );
    cityFoundation.position.set(0.3, -0.26, 0.3);
    cityFoundation.receiveShadow = true;
    scene.add(cityFoundation);

    // Lush Green Park / Grass Apron Platform surrounding the plaza
    const parkGrassMat = new THREE.MeshStandardMaterial({
      color: '#2D6A3E',
      roughness: 0.82,
      metalness: 0.05,
    });
    const parkApron = new THREE.Mesh(new THREE.BoxGeometry(12.2, 0.12, 11.6), parkGrassMat);
    parkApron.position.set(0.35, -0.05, -0.15);
    parkApron.receiveShadow = true;
    scene.add(parkApron);

    // Raised Stone Sidewalk Curbs around the 4x4 Plaza
    const plazaCurb = new THREE.Mesh(
      new THREE.BoxGeometry(8.95, 0.14, 8.95),
      new THREE.MeshStandardMaterial({ color: '#334155', roughness: 0.75 })
    );
    plazaCurb.position.set(0, -0.02, 0);
    plazaCurb.receiveShadow = true;
    scene.add(plazaCurb);

    // Dark-Asphalt Perimeter Streets (West Avenue & South Avenue + Intersection)
    const asphaltMat = new THREE.MeshStandardMaterial({
      color: '#1C2433',
      roughness: 0.88,
      metalness: 0.08,
    });
    // South Avenue
    const southRoad = new THREE.Mesh(new THREE.BoxGeometry(16.4, 0.13, 2.35), asphaltMat);
    southRoad.position.set(0.3, -0.035, 5.45);
    southRoad.receiveShadow = true;
    scene.add(southRoad);

    // West Avenue
    const westRoad = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.13, 15.2), asphaltMat);
    westRoad.position.set(-5.55, -0.035, 0.3);
    westRoad.receiveShadow = true;
    scene.add(westRoad);

    // East Service Bay Road (where the Green Recycling Truck parks)
    const eastBayRoad = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.13, 10.5), asphaltMat);
    eastBayRoad.position.set(5.45, -0.035, 1.6);
    eastBayRoad.receiveShadow = true;
    scene.add(eastBayRoad);

    // Crisp White Crosswalk Stripes & Dashed Road Markings
    const stripeMat = new THREE.MeshBasicMaterial({ color: '#E2E8F0' });
    const yellowLineMat = new THREE.MeshBasicMaterial({ color: '#FACC15' });

    // Crosswalk 1: West road crossing into Plaza
    for (let i = -2; i <= 2; i++) {
      const cw = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.85), stripeMat);
      cw.position.set(-5.55 + i * 0.38, 0.035, 3.65);
      scene.add(cw);
    }
    // Crosswalk 2: South road crossing
    for (let i = -2; i <= 2; i++) {
      const cw = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.02, 0.22), stripeMat);
      cw.position.set(-3.55, 0.035, 5.45 + i * 0.38);
      scene.add(cw);
    }
    // Dashed center lines on South & West roads
    for (let i = -2; i <= 3; i++) {
      const dashS = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.02, 0.09), yellowLineMat);
      dashS.position.set(i * 1.9, 0.035, 5.45);
      scene.add(dashS);
    }
    for (let i = -3; i <= 1; i++) {
      const dashW = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.95), yellowLineMat);
      dashW.position.set(-5.55, 0.035, i * 1.9);
      scene.add(dashW);
    }

    // 5. Low-Poly Stylized Trees, Park Bushes & Glowing Warm Streetlamps
    const addStylizedTree = (tx: number, tz: number, scale = 1.0) => {
      const treeGroup = new THREE.Group();
      treeGroup.position.set(tx, 0, tz);

      const trunk = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.65, 0.28),
        new THREE.MeshStandardMaterial({ color: '#5C3A21', roughness: 0.85 })
      );
      trunk.position.y = 0.32;
      trunk.castShadow = true;
      treeGroup.add(trunk);

      const crownBottom = new THREE.Mesh(
        new THREE.BoxGeometry(1.12, 0.62, 1.12),
        new THREE.MeshStandardMaterial({ color: '#1F7A3A', roughness: 0.75 })
      );
      crownBottom.position.y = 0.88;
      crownBottom.castShadow = true;
      crownBottom.receiveShadow = true;
      treeGroup.add(crownBottom);

      const crownMid = new THREE.Mesh(
        new THREE.BoxGeometry(0.86, 0.52, 0.86),
        new THREE.MeshStandardMaterial({ color: '#2E9E4B', roughness: 0.7 })
      );
      crownMid.position.y = 1.38;
      crownMid.castShadow = true;
      treeGroup.add(crownMid);

      const crownTop = new THREE.Mesh(
        new THREE.BoxGeometry(0.54, 0.36, 0.54),
        new THREE.MeshStandardMaterial({ color: '#4ADE80', roughness: 0.65 })
      );
      crownTop.position.y = 1.76;
      crownTop.castShadow = true;
      treeGroup.add(crownTop);

      treeGroup.scale.setScalar(scale);
      scene.add(treeGroup);
    };

    const treePositions: Array<[number, number, number]> = [
      [-4.1, -3.9, 1.05],
      [-4.15, -1.1, 0.92],
      [-4.15, 1.2, 0.88],
      [-4.0, 3.85, 1.1],
      [-1.4, -4.15, 0.95],
      [1.4, -4.15, 1.05],
      [4.15, -3.85, 1.12],
      [4.95, -2.55, 0.95],
      [4.15, -1.25, 0.88],
      [2.1, 4.08, 0.92],
      [-1.8, 4.08, 0.85],
    ];
    for (const [tx, tz, sc] of treePositions) {
      addStylizedTree(tx, tz, sc);
    }

    // Small park bushes & green park waste receptacles
    const addParkBush = (bx: number, bz: number) => {
      const bush = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.35, 0.42),
        new THREE.MeshStandardMaterial({ color: '#228B3B', roughness: 0.8 })
      );
      bush.position.set(bx, 0.18, bz);
      bush.castShadow = true;
      scene.add(bush);
    };
    addParkBush(-4.1, 0.1);
    addParkBush(0.0, -4.1);
    addParkBush(3.2, -4.1);
    addParkBush(-0.2, 4.05);

    // Warm Glowing Streetlamps
    const addStreetLamp = (lx: number, lz: number) => {
      const lampGroup = new THREE.Group();
      lampGroup.position.set(lx, 0, lz);

      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.08, 1.65, 10),
        new THREE.MeshStandardMaterial({ color: '#1E293B', metalness: 0.6, roughness: 0.4 })
      );
      post.position.y = 0.82;
      post.castShadow = true;
      lampGroup.add(post);

      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 12, 12),
        new THREE.MeshBasicMaterial({ color: '#FEF08A' })
      );
      bulb.position.y = 1.72;
      lampGroup.add(bulb);

      const cap = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, 0.14, 10),
        new THREE.MeshStandardMaterial({ color: '#0F172A' })
      );
      cap.position.y = 1.84;
      lampGroup.add(cap);

      // Warm golden light pool on the ground
      const glowPool = new THREE.Mesh(
        new THREE.CircleGeometry(0.85, 24),
        new THREE.MeshBasicMaterial({
          color: '#FACC15',
          transparent: true,
          opacity: 0.22,
          side: THREE.DoubleSide,
        })
      );
      glowPool.rotation.x = -Math.PI / 2;
      glowPool.position.y = 0.065;
      lampGroup.add(glowPool);

      scene.add(lampGroup);
    };
    addStreetLamp(-3.85, -2.45);
    addStreetLamp(-3.85, 2.55);
    addStreetLamp(3.85, -2.45);
    addStreetLamp(0.45, 3.95);

    // 6. 4x4 Tile Grid (T01..T16)
    const tileMeshes = new Map<TileId, THREE.Mesh>();
    const tileHighlightRings = new Map<TileId, THREE.Mesh>();
    const initialWasteTiles = new Set<TileId>([
      'T02',
      'T04',
      'T05',
      'T07',
      'T10',
      'T12',
      'T13',
      'T15',
    ]);

    const tileGeo = new THREE.BoxGeometry(1.94, 0.14, 1.94);
    const ringGeo = new THREE.RingGeometry(0.68, 0.86, 32);
    ringGeo.rotateX(-Math.PI / 2);

    for (const tileId of VALID_TILES) {
      const pos = getTileWorldPos(tileId);
      const tex = createTileLabelTexture(tileId, initialWasteTiles.has(tileId));

      const sideMat = new THREE.MeshStandardMaterial({
        color: '#1E293B',
        roughness: 0.8,
      });
      const topMat = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.68,
        metalness: 0.08,
      });

      const mesh = new THREE.Mesh(tileGeo, [
        sideMat,
        sideMat,
        topMat,
        sideMat,
        sideMat,
        sideMat,
      ]);
      mesh.position.set(pos.x, 0, pos.z);
      mesh.receiveShadow = true;
      scene.add(mesh);
      tileMeshes.set(tileId, mesh);

      const ringMat = new THREE.MeshBasicMaterial({
        color: '#38BDF8',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0,
      });
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.position.set(pos.x, 0.085, pos.z);
      scene.add(ringMesh);
      tileHighlightRings.set(tileId, ringMesh);
    }

    // 7. Stylized Architectural Buildings on North/West Perimeter with Warm Illuminated Windows
    const buildingSpecs = [
      { x: -5.55, z: -4.9, w: 2.1, h: 3.1, d: 2.1, rows: 5, cols: 3, color: '#273549' },
      { x: -2.6, z: -5.45, w: 2.8, h: 2.5, d: 1.75, rows: 4, cols: 4, color: '#1E293B' },
      { x: 0.65, z: -5.45, w: 2.9, h: 3.2, d: 1.75, rows: 5, cols: 4, color: '#243247' },
      { x: 3.85, z: -5.45, w: 2.4, h: 2.2, d: 1.75, rows: 3, cols: 3, color: '#1E293B' },
    ];

    for (const b of buildingSpecs) {
      const bGroup = new THREE.Group();
      bGroup.position.set(b.x, 0, b.z);

      const facadeTex = createBuildingFacadeTexture(b.rows, b.cols, b.color);
      const wallMat = new THREE.MeshStandardMaterial({
        map: facadeTex,
        roughness: 0.65,
        metalness: 0.15,
      });
      const roofTopMat = new THREE.MeshStandardMaterial({
        color: '#334155',
        roughness: 0.8,
      });

      const bGeo = new THREE.BoxGeometry(b.w, b.h, b.d);
      const bMesh = new THREE.Mesh(bGeo, [
        wallMat,
        wallMat,
        roofTopMat,
        roofTopMat,
        wallMat,
        wallMat,
      ]);
      bMesh.position.y = b.h / 2;
      bMesh.castShadow = true;
      bMesh.receiveShadow = true;
      bGroup.add(bMesh);

      // Roof cornice ledge
      const cornice = new THREE.Mesh(
        new THREE.BoxGeometry(b.w + 0.12, 0.14, b.d + 0.12),
        new THREE.MeshStandardMaterial({ color: '#475569', roughness: 0.7 })
      );
      cornice.position.y = b.h + 0.05;
      bGroup.add(cornice);

      // Rooftop HVAC unit
      const hvac = new THREE.Mesh(
        new THREE.BoxGeometry(b.w * 0.38, 0.28, b.d * 0.38),
        new THREE.MeshStandardMaterial({ color: '#1E293B' })
      );
      hvac.position.set(0.15, b.h + 0.24, -0.1);
      bGroup.add(hvac);

      scene.add(bGroup);
    }

    // 8. Central Disposal Bin Station + Procedural Green-and-White Municipal Recycling Truck
    const binGroup = new THREE.Group();
    binGroup.position.copy(DISPOSAL_BIN_POS);

    const binBaseGeo = new THREE.BoxGeometry(1.58, 0.82, 2.08);
    const binBaseMat = new THREE.MeshStandardMaterial({
      color: '#15803D',
      roughness: 0.45,
      metalness: 0.2,
    });
    const binBaseMesh = new THREE.Mesh(binBaseGeo, binBaseMat);
    binBaseMesh.position.y = 0.41;
    binBaseMesh.castShadow = true;
    binBaseMesh.receiveShadow = true;
    binGroup.add(binBaseMesh);

    // Yellow/Emerald collar rim on the disposal bin
    const binRim = new THREE.Mesh(
      new THREE.BoxGeometry(1.66, 0.1, 2.16),
      new THREE.MeshStandardMaterial({ color: '#22C55E', roughness: 0.4 })
    );
    binRim.position.y = 0.83;
    binGroup.add(binRim);

    const binEdges = new THREE.EdgesGeometry(binBaseGeo);
    const binEdgeMat = new THREE.LineBasicMaterial({ color: '#34D399' });
    const binEdgeLines = new THREE.LineSegments(binEdges, binEdgeMat);
    binEdgeLines.position.y = 0.41;
    binGroup.add(binEdgeLines);

    scene.add(binGroup);

    // Green & White Municipal Recycling Collection Truck parked on SE Service Bay
    const truckGroup = new THREE.Group();
    truckGroup.position.copy(TRUCK_POS);
    truckGroup.rotation.y = -Math.PI / 2; // Facing West along the South avenue

    // Green Cargo Compactor Body
    const truckCargo = new THREE.Mesh(
      new THREE.BoxGeometry(2.35, 1.48, 1.52),
      new THREE.MeshStandardMaterial({ color: '#16A34A', roughness: 0.45, metalness: 0.15 })
    );
    truckCargo.position.set(-0.45, 0.96, 0);
    truckCargo.castShadow = true;
    truckCargo.receiveShadow = true;
    truckGroup.add(truckCargo);

    // Crisp White Stripe along Cargo Box
    const cargoStripe = new THREE.Mesh(
      new THREE.BoxGeometry(2.38, 0.22, 1.56),
      new THREE.MeshStandardMaterial({ color: '#F8FAFC', roughness: 0.35 })
    );
    cargoStripe.position.set(-0.45, 0.82, 0);
    truckGroup.add(cargoStripe);

    // White Truck Cab
    const truckCab = new THREE.Mesh(
      new THREE.BoxGeometry(1.12, 1.18, 1.44),
      new THREE.MeshStandardMaterial({ color: '#F8FAFC', roughness: 0.35, metalness: 0.15 })
    );
    truckCab.position.set(1.32, 0.81, 0);
    truckCab.castShadow = true;
    truckCab.receiveShadow = true;
    truckGroup.add(truckCab);

    // Dark Tinted Windshield & Side Windows
    const windshield = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.48, 1.48),
      new THREE.MeshStandardMaterial({ color: '#0F172A', roughness: 0.2, metalness: 0.6 })
    );
    windshield.position.set(1.62, 0.98, 0);
    truckGroup.add(windshield);

    // Front Bumper & Headlights
    const bumper = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.24, 1.48),
      new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.5 })
    );
    bumper.position.set(1.9, 0.32, 0);
    truckGroup.add(bumper);

    // 4 Truck Wheels
    const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.26, 16);
    wheelGeo.rotateX(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: '#0F172A', roughness: 0.9 });
    for (const [wx, wz] of [
      [-1.05, 0.72],
      [-1.05, -0.72],
      [1.25, 0.72],
      [1.25, -0.72],
    ]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(wx, 0.32, wz);
      truckGroup.add(wheel);
    }

    scene.add(truckGroup);

    // 9. Cute Stylized White-and-Blue Rounded AI Robot (CLEANCO-BOT)
    const workerGroup = new THREE.Group();
    workerGroup.position.copy(WORKER_HOME_POS);

    const whiteBotMat = new THREE.MeshStandardMaterial({
      color: '#F8FAFC',
      roughness: 0.25,
      metalness: 0.15,
    });
    const darkJointMat = new THREE.MeshStandardMaterial({
      color: '#1E293B',
      roughness: 0.45,
      metalness: 0.4,
    });
    const blueAccentMat = new THREE.MeshStandardMaterial({
      color: '#2563EB',
      roughness: 0.35,
      metalness: 0.3,
    });

    // Lower hover/wheel base
    const basePod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.4, 0.28, 20),
      darkJointMat
    );
    basePod.position.y = 0.2;
    basePod.castShadow = true;
    workerGroup.add(basePod);

    // Rounded White Torso
    const torsoMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.34, 0.56, 24),
      whiteBotMat
    );
    torsoMesh.position.y = 0.62;
    torsoMesh.castShadow = true;
    workerGroup.add(torsoMesh);

    // Chest Emblem Badge (Green/Cyan CleanCo Core)
    const chestPlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.24, 0.12),
      new THREE.MeshStandardMaterial({ color: '#0F172A', roughness: 0.3 })
    );
    chestPlate.position.set(0, 0.64, 0.36);
    workerGroup.add(chestPlate);

    const chestCore = new THREE.Mesh(
      new THREE.CircleGeometry(0.08, 16),
      new THREE.MeshBasicMaterial({ color: '#34D399' })
    );
    chestCore.position.set(0, 0.64, 0.43);
    workerGroup.add(chestCore);

    // Articulated Arms
    const armGeo = new THREE.CylinderGeometry(0.09, 0.08, 0.42, 12);
    const leftArm = new THREE.Mesh(armGeo, whiteBotMat);
    leftArm.position.set(-0.48, 0.6, 0.12);
    leftArm.rotation.x = -Math.PI / 6;
    leftArm.castShadow = true;
    workerGroup.add(leftArm);

    const rightArm = new THREE.Mesh(armGeo, whiteBotMat);
    rightArm.position.set(0.48, 0.6, 0.12);
    rightArm.rotation.x = -Math.PI / 6;
    rightArm.castShadow = true;
    workerGroup.add(rightArm);

    // Cute Rounded White Robot Head
    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.46, 24, 20), whiteBotMat);
    headMesh.scale.set(1.08, 0.92, 0.98);
    headMesh.position.y = 1.24;
    headMesh.castShadow = true;
    workerGroup.add(headMesh);

    // Blue Ear Pods
    const earGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.12, 16);
    earGeo.rotateZ(Math.PI / 2);
    const leftEar = new THREE.Mesh(earGeo, blueAccentMat);
    leftEar.position.set(-0.5, 1.24, 0);
    workerGroup.add(leftEar);
    const rightEar = new THREE.Mesh(earGeo, blueAccentMat);
    rightEar.position.set(0.5, 1.24, 0);
    workerGroup.add(rightEar);

    // Sleek Dark Visor Faceplate
    const visorMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.64, 0.3, 0.24),
      new THREE.MeshStandardMaterial({ color: '#090D16', roughness: 0.15, metalness: 0.7 })
    );
    visorMesh.position.set(0, 1.24, 0.34);
    workerGroup.add(visorMesh);

    // Two Glowing Cyan Robot Eyes
    const eyeGeo = new THREE.CircleGeometry(0.085, 20);
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#38BDF8' });
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-0.15, 1.24, 0.465);
    workerGroup.add(leftEye);

    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.15, 1.24, 0.465);
    workerGroup.add(rightEye);

    // Eye highlight pupils
    const pupilGeo = new THREE.CircleGeometry(0.032, 12);
    const pupilMat = new THREE.MeshBasicMaterial({ color: '#E0F2FE' });
    const leftPupil = new THREE.Mesh(pupilGeo, pupilMat);
    leftPupil.position.set(-0.13, 1.26, 0.47);
    workerGroup.add(leftPupil);
    const rightPupil = new THREE.Mesh(pupilGeo, pupilMat);
    rightPupil.position.set(0.17, 1.26, 0.47);
    workerGroup.add(rightPupil);

    // Ground Hover Ring under Robot
    const workerRingGeo = new THREE.RingGeometry(0.46, 0.58, 32);
    workerRingGeo.rotateX(-Math.PI / 2);
    const workerRingMat = new THREE.MeshBasicMaterial({
      color: '#38BDF8',
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });
    const workerRing = new THREE.Mesh(workerRingGeo, workerRingMat);
    workerRing.position.y = 0.08;
    workerGroup.add(workerRing);

    scene.add(workerGroup);
    const workerTargetPos = WORKER_HOME_POS.clone();

    // 10. Blocked Event Beacon (Crimson pulse ring + vertical beam when decision === 'BLOCK')
    const blockBeaconGroup = new THREE.Group();
    blockBeaconGroup.visible = false;
    const blockRingGeo = new THREE.RingGeometry(0.45, 0.92, 32);
    blockRingGeo.rotateX(-Math.PI / 2);
    const blockRingMat = new THREE.MeshBasicMaterial({
      color: '#EF4444',
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });
    const blockRingMesh = new THREE.Mesh(blockRingGeo, blockRingMat);
    blockRingMesh.position.y = 0.11;
    blockBeaconGroup.add(blockRingMesh);

    const blockBeamGeo = new THREE.CylinderGeometry(0.18, 0.55, 1.8, 16, 1, true);
    const blockBeamMat = new THREE.MeshBasicMaterial({
      color: '#EF4444',
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
    });
    const blockBeamMesh = new THREE.Mesh(blockBeamGeo, blockBeamMat);
    blockBeamMesh.position.y = 0.95;
    blockBeaconGroup.add(blockBeamMesh);
    scene.add(blockBeaconGroup);

    // 10b. Dynamic 3D Trajectory Path Group on the Plaza Floor (Coral #FF6B6B for Run A, Mint #20D997 for Run B)
    const trajectoryGroup = new THREE.Group();
    trajectoryGroup.position.y = 0.095;
    scene.add(trajectoryGroup);
    let lastTrajectoryKey = '';

    // 11. 8 Stylized Trash Bags / Canisters (W01..W08) + Ghost Origin Wireframes
    const wasteNodes = new Map<WasteId, WasteVisualNode>();
    const pickableObjects: THREE.Object3D[] = [];

    const bagGeo = new THREE.DodecahedronGeometry(0.36, 1);
    const knotGeo = new THREE.ConeGeometry(0.16, 0.18, 8);
    const collarGeo = new THREE.TorusGeometry(0.28, 0.045, 10, 20);
    collarGeo.rotateX(Math.PI / 2);
    const selRingGeo = new THREE.RingGeometry(0.44, 0.58, 28);
    selRingGeo.rotateX(-Math.PI / 2);

    for (const wasteId of VALID_WASTE_IDS) {
      const group = new THREE.Group();
      group.userData = { wasteId };

      // Dark charcoal tied trash bag body
      const bagMat = new THREE.MeshStandardMaterial({
        color: '#1F2937',
        roughness: 0.45,
        metalness: 0.25,
      });
      const bagMesh = new THREE.Mesh(bagGeo, bagMat);
      bagMesh.scale.set(1.05, 0.92, 1.05);
      bagMesh.position.y = 0.34;
      bagMesh.castShadow = true;
      bagMesh.receiveShadow = true;
      bagMesh.userData = { wasteId };
      group.add(bagMesh);
      pickableObjects.push(bagMesh);

      // Tied top knot of the trash bag
      const knotMat = new THREE.MeshStandardMaterial({
        color: '#374151',
        roughness: 0.5,
      });
      const knotMesh = new THREE.Mesh(knotGeo, knotMat);
      knotMesh.position.y = 0.68;
      knotMesh.rotation.z = 0.12;
      knotMesh.userData = { wasteId };
      group.add(knotMesh);
      pickableObjects.push(knotMesh);

      // High-visibility status collar band around the bag
      const collarMat = new THREE.MeshStandardMaterial({
        color: '#F59E0B',
        roughness: 0.3,
        emissive: '#78350F',
        emissiveIntensity: 0.3,
      });
      const collarMesh = new THREE.Mesh(collarGeo, collarMat);
      collarMesh.position.y = 0.22;
      collarMesh.userData = { wasteId };
      group.add(collarMesh);
      pickableObjects.push(collarMesh);

      const selRingMat = new THREE.MeshBasicMaterial({
        color: '#F8FAFC',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0,
      });
      const selectionRing = new THREE.Mesh(selRingGeo, selRingMat);
      selectionRing.position.y = 0.095;
      group.add(selectionRing);

      // Overhead Sprite Pill (#W1..#W8)
      const initialTex = createWasteBadgeTexture(wasteId, 'PUBLIC', false);
      const badgeMaterial = new THREE.SpriteMaterial({
        map: initialTex,
        depthTest: false,
        transparent: true,
      });
      const badgeSprite = new THREE.Sprite(badgeMaterial);
      badgeSprite.position.set(0, 1.12, 0);
      badgeSprite.scale.set(1.55, 0.48, 1);
      badgeSprite.userData = { wasteId };
      group.add(badgeSprite);
      pickableObjects.push(badgeSprite);

      // Ghost Origin Group (shown at lastKnownPublicTileId when DISPOSED and selected/active)
      const ghostGroup = new THREE.Group();
      ghostGroup.visible = false;
      ghostGroup.userData = { wasteId };

      const ghostEdges = new THREE.EdgesGeometry(bagGeo);
      const ghostWire = new THREE.LineSegments(
        ghostEdges,
        new THREE.LineBasicMaterial({
          color: '#22D3EE',
          transparent: true,
          opacity: 0.85,
        })
      );
      ghostWire.position.y = 0.34;
      ghostGroup.add(ghostWire);

      const ghostRing = new THREE.Mesh(
        selRingGeo,
        new THREE.MeshBasicMaterial({
          color: '#22D3EE',
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.75,
        })
      );
      ghostRing.position.y = 0.095;
      ghostGroup.add(ghostRing);

      const ghostBadgeTex = createWasteBadgeTexture(wasteId, 'DISPOSED', true, true);
      const ghostBadge = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: ghostBadgeTex,
          depthTest: false,
          transparent: true,
        })
      );
      ghostBadge.position.set(0, 1.12, 0);
      ghostBadge.scale.set(1.65, 0.5, 1);
      ghostGroup.add(ghostBadge);

      scene.add(ghostGroup);
      scene.add(group);

      wasteNodes.set(wasteId, {
        group,
        bagMesh,
        knotMesh,
        collarMesh,
        badgeSprite,
        badgeMaterial,
        selectionRing,
        targetPos: new THREE.Vector3(),
        targetScale: 1,
        ghostGroup,
        lastBadgeKey: '',
      });
    }

    // 12. Raycaster for P1-1 Waste Click & Hover Reverse History Filter (AT-19)
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerDownPos = { x: 0, y: 0 };

    const getHitWasteId = (clientX: number, clientY: number): WasteId | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const intersects = raycaster.intersectObjects(pickableObjects, false);
      if (intersects.length > 0) {
        const hit = intersects[0].object;
        const wId = (hit.userData?.wasteId || hit.parent?.userData?.wasteId) as WasteId | undefined;
        return wId ?? null;
      }
      return null;
    };

    const handlePointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
    };

    const handlePointerUp = (e: PointerEvent) => {
      const dx = Math.abs(e.clientX - pointerDownPos.x);
      const dy = Math.abs(e.clientY - pointerDownPos.y);
      if (dx > 6 || dy > 6) return;

      const hitWasteId = getHitWasteId(e.clientX, e.clientY);
      if (hitWasteId) {
        const next = selectedWasteRef.current === hitWasteId ? null : hitWasteId;
        onSelectWasteRef.current(next);
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      const hitWasteId = getHitWasteId(e.clientX, e.clientY);
      setHoveredWasteId(hitWasteId);
      renderer.domElement.style.cursor = hitWasteId ? 'pointer' : 'grab';
    };

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);
    renderer.domElement.addEventListener('pointermove', handlePointerMove);

    // 13. Resize Observer
    const handleResize = () => {
      if (!container) return;
      const w = Math.max(container.clientWidth, 320);
      const h = Math.max(container.clientHeight, 320);
      const asp = w / h;
      camera.left = (-frustumSize * asp) / 2;
      camera.right = (frustumSize * asp) / 2;
      camera.top = frustumSize / 2;
      camera.bottom = -frustumSize / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    // 14. Animation Loop (Pure projection of projectedRef.current)
    let animFrameId = 0;
    const clock = new THREE.Clock();

    const animate = () => {
      animFrameId = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.1);
      const elapsed = clock.getElapsedTime();

      const snap = projectedRef.current;
      const selWaste = selectedWasteRef.current;
      const immediate = shouldSnapRef.current;
      shouldSnapRef.current = false;

      // Rebuild 3D Floor Trajectory Path Lines & Loop/Delivery Markers when frame or run changes
      const runLabelHint =
        activeExperimentLabelRef.current ??
        (snap.runId.toLowerCase().includes('exp_b') ? 'RUN B' : 'RUN A');
      const isRunB = runLabelHint.toUpperCase().includes('B');
      const trajectoryKey = `${snap.runId}:${snap.frameIndex}:${isRunB ? 'B' : 'A'}`;

      if (trajectoryKey !== lastTrajectoryKey) {
        lastTrajectoryKey = trajectoryKey;
        while (trajectoryGroup.children.length > 0) {
          const child = trajectoryGroup.children[0];
          trajectoryGroup.remove(child);
        }

        const primaryColor = isRunB ? '#20D997' : '#FF6B6B';
        const pairCounts = new Map<string, number>();

        for (let idx = 0; idx < snap.trajectoryHistory.length; idx++) {
          const seg = snap.trajectoryHistory[idx];
          const isLatest = idx === snap.trajectoryHistory.length - 1;
          const segColor =
            seg.decision === 'BLOCK' ? '#EF4444' : primaryColor;
          const segOpacity = isLatest ? 0.92 : 0.58;

          const p1 = getLocationWorldPos(seg.fromLocation);
          const p2 = getLocationWorldPos(seg.toLocation);

          if (p1.distanceTo(p2) < 0.05) {
            // Same-tile action (e.g. PICK_UP followed by DROP on the same tile): draw a loop torus ring
            const loopTorus = new THREE.Mesh(
              new THREE.TorusGeometry(0.54, 0.045, 10, 28),
              new THREE.MeshBasicMaterial({
                color: segColor,
                transparent: true,
                opacity: segOpacity,
              })
            );
            loopTorus.rotation.x = Math.PI / 2;
            loopTorus.position.set(p2.x, 0.025 + idx * 0.005, p2.z);
            trajectoryGroup.add(loopTorus);
          } else {
            const pairKey = [seg.fromLocation, seg.toLocation].sort().join('::');
            const seenCount = pairCounts.get(pairKey) ?? 0;
            pairCounts.set(pairKey, seenCount + 1);

            const dir = new THREE.Vector3().subVectors(p2, p1);
            const len = dir.length();
            const dirNorm = dir.clone().normalize();
            const perp = new THREE.Vector3(-dirNorm.z, 0, dirNorm.x);

            // Offset repeated segments between the same two locations so forward & return loop paths are both visible
            const lateralOffset =
              seenCount === 0
                ? 0
                : (seenCount % 2 === 1 ? 1 : -1) *
                  0.16 *
                  Math.ceil(seenCount / 2);

            const startPt = p1
              .clone()
              .addScaledVector(perp, lateralOffset)
              .addScaledVector(dirNorm, 0.28);
            const endPt = p2
              .clone()
              .addScaledVector(perp, lateralOffset)
              .addScaledVector(dirNorm, -0.28);
            const segVec = new THREE.Vector3().subVectors(endPt, startPt);
            const segLen = Math.max(0.15, segVec.length());
            const midPt = new THREE.Vector3()
              .addVectors(startPt, endPt)
              .multiplyScalar(0.5);

            // Glowing floor ribbon strip
            const ribbonGeo = new THREE.BoxGeometry(
              isLatest ? 0.13 : 0.09,
              0.022,
              segLen
            );
            const ribbonMat = new THREE.MeshBasicMaterial({
              color: segColor,
              transparent: true,
              opacity: segOpacity,
            });
            const ribbonMesh = new THREE.Mesh(ribbonGeo, ribbonMat);
            ribbonMesh.position.set(midPt.x, 0.015 + idx * 0.003, midPt.z);
            ribbonMesh.rotation.y = Math.atan2(dirNorm.x, dirNorm.z);
            trajectoryGroup.add(ribbonMesh);

            // Directional arrowhead cone along the segment
            const arrowPos = startPt
              .clone()
              .lerp(endPt, 0.76);
            const coneGeo = new THREE.ConeGeometry(
              isLatest ? 0.16 : 0.12,
              0.32,
              10
            );
            coneGeo.rotateX(Math.PI / 2);
            const coneMesh = new THREE.Mesh(
              coneGeo,
              new THREE.MeshBasicMaterial({
                color: segColor,
                transparent: true,
                opacity: Math.min(1, segOpacity + 0.1),
              })
            );
            coneMesh.position.set(arrowPos.x, 0.03 + idx * 0.003, arrowPos.z);
            coneMesh.rotation.y = Math.atan2(dirNorm.x, dirNorm.z);
            trajectoryGroup.add(coneMesh);

            // Waypoint node dot at destination
            const dotMesh = new THREE.Mesh(
              new THREE.CylinderGeometry(0.12, 0.12, 0.025, 14),
              new THREE.MeshBasicMaterial({
                color: segColor,
                transparent: true,
                opacity: segOpacity,
              })
            );
            dotMesh.position.set(p2.x, 0.02, p2.z);
            trajectoryGroup.add(dotMesh);
          }
        }
      }

      // Determine Worker target position from projected.workerTargetLocation (invariant on BLOCK per AT-17)
      if (snap.workerTargetLocation === 'HOME_PAD') {
        workerTargetPos.copy(WORKER_HOME_POS);
      } else if (snap.workerTargetLocation === 'DISPOSAL_BIN') {
        workerTargetPos.set(DISPOSAL_BIN_POS.x - 1.35, 0, DISPOSAL_BIN_POS.z);
      } else {
        const tPos = getTileWorldPos(snap.workerTargetLocation);
        workerTargetPos.set(tPos.x, 0, tPos.z);
      }

      if (immediate) {
        workerGroup.position.copy(workerTargetPos);
      } else {
        workerGroup.position.x = THREE.MathUtils.damp(
          workerGroup.position.x,
          workerTargetPos.x,
          9,
          dt
        );
        workerGroup.position.z = THREE.MathUtils.damp(
          workerGroup.position.z,
          workerTargetPos.z,
          9,
          dt
        );
      }

      // Subtle idle float on robot head
      headMesh.position.y = 1.24 + 0.025 * Math.sin(elapsed * 3.5);
      visorMesh.position.y = headMesh.position.y;
      leftEye.position.y = headMesh.position.y;
      rightEye.position.y = headMesh.position.y;
      leftPupil.position.y = headMesh.position.y + 0.02;
      rightPupil.position.y = headMesh.position.y + 0.02;

      // Highlight Disposal Bin wireframe when highlightDisposalBin is true
      binEdgeMat.color.set(snap.highlightDisposalBin ? '#6EE7B7' : '#10B981');

      // Highlight active tile or BLOCK beacon
      const activeEv = snap.activeEvent;
      for (const [tId, ringMesh] of tileHighlightRings.entries()) {
        const mat = ringMesh.material as THREE.MeshBasicMaterial;
        const isTargetTile = snap.highlightedTileId === tId;

        if (isTargetTile) {
          mat.color.set(activeEv?.decision === 'BLOCK' ? '#EF4444' : '#38BDF8');
          mat.opacity = 0.78 + 0.2 * Math.sin(elapsed * 6);
        } else {
          mat.opacity = 0;
        }
      }

      if (activeEv && activeEv.decision === 'BLOCK') {
        blockBeaconGroup.visible = true;
        if (snap.highlightedTileId) {
          const bPos = getTileWorldPos(snap.highlightedTileId);
          blockBeaconGroup.position.set(bPos.x, 0, bPos.z);
        } else {
          blockBeaconGroup.position.set(workerGroup.position.x, 0, workerGroup.position.z);
        }
        blockBeamMat.opacity = 0.22 + 0.15 * Math.sin(elapsed * 10);
      } else {
        blockBeaconGroup.visible = false;
      }

      // Update each Waste bag/canister from projected.wastes
      for (const wasteId of VALID_WASTE_IDS) {
        const wState = snap.wastes[wasteId];
        const node = wasteNodes.get(wasteId);
        if (!wState || !node) continue;

        const isSelected = selWaste === wasteId;
        const isActiveWaste = wState.isActiveEventTarget;
        const bagMat = node.bagMesh.material as THREE.MeshStandardMaterial;
        const collarMat = node.collarMesh.material as THREE.MeshStandardMaterial;

        if (wState.status === 'PUBLIC' && wState.currentTileId) {
          const tPos = getTileWorldPos(wState.currentTileId);
          node.targetPos.set(tPos.x, 0, tPos.z);
          node.targetScale = 1.0;
          bagMat.color.set('#1F2937');
          collarMat.color.set('#F59E0B');
          node.ghostGroup.visible = false;
        } else if (wState.status === 'CARRIED') {
          // Held right in front of the robot's hands like the screenshot
          node.targetPos.set(
            workerGroup.position.x - 0.36,
            0.18,
            workerGroup.position.z + 0.42
          );
          node.targetScale = 0.92;
          bagMat.color.set('#1E293B');
          collarMat.color.set('#38BDF8');
          node.ghostGroup.visible = false;
        } else {
          // DISPOSED: place neatly inside the Disposal Bin containment rack
          const slotPos = getDisposedSlotWorldPos(wasteId);
          node.targetPos.copy(slotPos);
          node.targetScale = 0.68;
          bagMat.color.set('#065F46');
          collarMat.color.set('#10B981');

          // Show Ghost Outline at lastKnownPublicTileId when selected or active (AT-19 / §6.4)
          if ((isSelected || isActiveWaste) && wState.lastKnownPublicTileId) {
            const originPos = getTileWorldPos(wState.lastKnownPublicTileId);
            node.ghostGroup.position.copy(originPos);
            node.ghostGroup.visible = true;
          } else {
            node.ghostGroup.visible = false;
          }
        }

        if (immediate || wState.status === 'CARRIED') {
          node.group.position.copy(node.targetPos);
          node.group.scale.setScalar(node.targetScale);
        } else {
          node.group.position.x = THREE.MathUtils.damp(
            node.group.position.x,
            node.targetPos.x,
            10,
            dt
          );
          node.group.position.y = THREE.MathUtils.damp(
            node.group.position.y,
            node.targetPos.y,
            10,
            dt
          );
          node.group.position.z = THREE.MathUtils.damp(
            node.group.position.z,
            node.targetPos.z,
            10,
            dt
          );
          const nextScale = THREE.MathUtils.damp(
            node.group.scale.x,
            node.targetScale,
            10,
            dt
          );
          node.group.scale.setScalar(nextScale);
        }

        // Selection ring visibility
        const ringMat = node.selectionRing.material as THREE.MeshBasicMaterial;
        if (isSelected || isActiveWaste) {
          ringMat.color.set(isSelected ? '#F8FAFC' : '#38BDF8');
          ringMat.opacity = 0.85;
        } else {
          ringMat.opacity = 0;
        }

        // Update overhead badge texture only when state or selection changes
        const badgeKey = `${wState.status}:${isSelected ? '1' : '0'}`;
        if (node.lastBadgeKey !== badgeKey) {
          node.lastBadgeKey = badgeKey;
          const oldMap = node.badgeMaterial.map;
          node.badgeMaterial.map = createWasteBadgeTexture(
            wasteId,
            wState.status,
            isSelected
          );
          node.badgeMaterial.needsUpdate = true;
          oldMap?.dispose();
        }
      }

      controls.update();
      renderer.render(scene, camera);
    };

    animFrameId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animFrameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      controls.dispose();
      renderer.dispose();
    };
  }, [onWebGLFailure]);

  const activeEv = projected.activeEvent;
  const derivedRunLabel =
    activeExperimentLabel ??
    (projected.runId.toLowerCase().includes('exp_b') ? 'RUN B' : 'RUN A');
  const selectedForensics = selectedWasteId
    ? projected.wasteForensics[selectedWasteId]
    : null;
  const selectedWasteState = selectedWasteId
    ? projected.wastes[selectedWasteId]
    : null;

  return (
    <div className="relative w-full h-full bg-[#0B101B] overflow-hidden select-none">
      {/* Three.js WebGL 2 Mount Container */}
      <div
        ref={mountRef}
        className="w-full h-full"
        data-testid="digital-twin-3d-canvas"
      />

      {/* Top-Left Compact Telemetry & Camera Reset Pill (Opaque — ZERO backdrop-filter per §2.3) */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-[#0F172A] border border-slate-800 rounded-lg px-2.5 py-1.5 shadow-lg">
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
        <div className="flex items-center gap-2.5 font-mono text-[11px]">
          <span className="text-amber-400">
            PUB <strong>{projected.world.publicCount}</strong>
          </span>
          <span className="text-cyan-400">
            CARRY <strong>{projected.world.carriedCount}</strong>
          </span>
          <span className="text-emerald-400">
            DISP <strong>{projected.world.disposedCount}</strong>/8
          </span>
        </div>
        <button
          type="button"
          onClick={() => cameraResetRef.current?.()}
          className="ml-1 px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 text-slate-300 font-mono text-[10px] border border-slate-700 cursor-pointer"
          title="Reset isometric camera view"
        >
          RESET CAM
        </button>
      </div>

      {/* 3D Raycaster Object Forensics Popover Card (Concept 04 — Opaque, ZERO backdrop-filter) */}
      {selectedWasteId && selectedForensics && selectedWasteState && (
        <div
          data-testid="object-forensics-popover"
          className="absolute top-14 left-3 z-20 w-[238px] bg-[#0F172A] border border-cyan-500/70 rounded-xl p-3 shadow-2xl"
        >
          <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-slate-800">
            <div>
              <div className="text-[9px] font-bold tracking-widest text-cyan-400 uppercase">
                OBJECT SELECTED
              </div>
              <div className="font-display text-sm font-extrabold text-white">
                #{selectedWasteId.replace('W0', 'W')} ({selectedWasteId})
              </div>
            </div>
            <button
              type="button"
              onClick={() => onSelectWasteId(null)}
              className="px-1.5 py-0.5 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white font-mono text-[10px] border border-slate-700 cursor-pointer"
              title="Clear object selection"
            >
              ✕
            </button>
          </div>

          <div className="mt-2 space-y-1 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Initial Spawn Tile</span>
              <span className="font-mono font-semibold text-slate-200">
                {selectedWasteState.initialTileId ?? '—'} (Public)
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Current Status</span>
              <span
                className={`font-mono font-bold ${
                  selectedWasteState.status === 'DISPOSED'
                    ? 'text-[#20D997]'
                    : selectedWasteState.status === 'CARRIED'
                    ? 'text-cyan-300'
                    : 'text-amber-300'
                }`}
              >
                {selectedWasteState.status}
                {selectedWasteState.currentTileId
                  ? ` @ ${selectedWasteState.currentTileId}`
                  : selectedWasteState.lastKnownPublicTileId
                  ? ` · Ghost @ ${selectedWasteState.lastKnownPublicTileId}`
                  : ''}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Pickups / Drops</span>
              <span
                className={`font-mono font-bold ${
                  selectedForensics.dropCount > 0
                    ? 'text-[#FF6B6B]'
                    : 'text-slate-200'
                }`}
              >
                {selectedForensics.pickupCount}x Picked Up /{' '}
                {selectedForensics.dropCount}x Dropped
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Permanent Disposals</span>
              <span
                className={`font-mono font-bold ${
                  selectedForensics.disposeCount > 0
                    ? 'text-[#20D997]'
                    : 'text-[#FF6B6B]'
                }`}
              >
                {selectedForensics.disposeCount}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/80">
              <span className="text-slate-400">Total Cost Spent</span>
              <span className="font-mono font-bold text-white">
                {selectedForensics.totalCostSpent} Budget Units
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Floating Callout Banner near Top-Center matching Reference Screenshot (Opaque — ZERO backdrop-filter) */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 bg-[#0F172A] border border-slate-700 rounded-xl px-4 py-2 shadow-2xl pointer-events-none min-w-[205px]">
        <div className="font-mono text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
          {derivedRunLabel} · STEP {projected.frameIndex} / {projected.totalEvents}
        </div>
        {activeEv ? (
          <div className="mt-0.5 flex items-center gap-2">
            <span className="text-sm sm:text-base font-extrabold tracking-tight text-white">
              {activeEv.action} &nbsp;#{activeEv.wasteId.replace('W0', 'W')}
            </span>
            {activeEv.tileId && (
              <span className="font-mono text-xs text-slate-400">
                → {activeEv.tileId}
              </span>
            )}
            {activeEv.decision === 'BLOCK' && (
              <span className="px-1.5 py-0.5 rounded bg-red-950 text-red-300 border border-red-700 font-mono text-[10px] font-bold">
                BLOCK · {activeEv.reasonCode}
              </span>
            )}
          </div>
        ) : (
          <div className="mt-0.5 text-sm font-bold tracking-tight text-slate-200">
            INITIAL STATE · 8 PUBLIC ITEMS
          </div>
        )}
      </div>

      {/* Right-Side Vertical Legend Card matching Reference Screenshot (Opaque — ZERO backdrop-filter) */}
      <div className="absolute right-3 top-1/2 -translate-y-1/2 z-10 bg-[#0F172A] border border-slate-800 rounded-xl px-3 py-2.5 shadow-xl flex flex-col gap-2 pointer-events-none">
        <div className="flex items-center gap-2 text-xs text-slate-200 font-medium">
          <span className="text-sm leading-none">🤖</span>
          <span>Agent</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-200 font-medium">
          <span className="text-sm leading-none">🚛</span>
          <span>Truck</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-200 font-medium">
          <span className="text-sm leading-none">🗑️</span>
          <span>Trash</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-200 font-medium">
          <span className="text-sm leading-none">♻️</span>
          <span>Bin</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-200 font-medium">
          <span className="text-sm leading-none">📍</span>
          <span>Target</span>
        </div>
      </div>

      {/* Bottom-Left Compact Clickable #W1..#W8 Raycaster P1-1 Filter Bar (Opaque — ZERO backdrop-filter) */}
      <div className="absolute bottom-2.5 left-3 z-10 flex flex-col items-start gap-1.5">
        {selectedWasteId && (
          <div className="bg-[#0F172A] border border-cyan-500/70 rounded-lg px-2.5 py-1 font-mono text-[11px] text-cyan-300 shadow-lg flex items-center gap-2">
            <span>
              FILTER: <strong>{selectedWasteId}</strong>
            </span>
            {(() => {
              const w = projected.wastes[selectedWasteId];
              if (!w) return null;
              return (
                <span className="text-slate-300">
                  ({w.status}
                  {w.currentTileId
                    ? ` @ ${w.currentTileId}`
                    : w.lastKnownPublicTileId
                    ? ` · GHOST @ ${w.lastKnownPublicTileId}`
                    : ''}
                  )
                </span>
              );
            })()}
          </div>
        )}

        <div className="bg-[#0F172A] border border-slate-800 rounded-lg p-1 flex flex-wrap items-center gap-1 shadow-lg">
          {VALID_WASTE_IDS.map((wId) => {
            const wState = projected.wastes[wId];
            const isSel = selectedWasteId === wId;
            const isHov = hoveredWasteId === wId;
            let dotClass = 'bg-amber-400';
            if (wState?.status === 'CARRIED') dotClass = 'bg-cyan-400';
            if (wState?.status === 'DISPOSED') dotClass = 'bg-emerald-400';

            return (
              <button
                key={wId}
                type="button"
                onClick={() => onSelectWasteId(isSel ? null : wId)}
                data-testid={`waste-chip-${wId}`}
                className={`px-1.5 py-0.5 rounded font-mono text-[11px] flex items-center gap-1 transition-colors cursor-pointer border ${
                  isSel
                    ? 'bg-blue-600 text-white border-white font-bold'
                    : isHov
                    ? 'bg-slate-800 text-slate-100 border-slate-500'
                    : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-slate-700'
                }`}
                title={`${wId} (${wState?.status}${
                  wState?.currentTileId ? ` @ ${wState.currentTileId}` : ''
                }) — Click to filter EventLog timeline`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
                #{wId.replace('W0', 'W')}
              </button>
            );
          })}
          {selectedWasteId && (
            <button
              type="button"
              onClick={() => onSelectWasteId(null)}
              className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono text-[10px] border border-slate-600 cursor-pointer"
            >
              CLEAR
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
