import { useSyncExternalStore } from 'react';
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import type { Building, BuildingLayout, Graph, Node, ScanFeatures, SurfaceColorFace, SurfaceColors, ZoneConnections, ZoneView } from './data';
import { graphDigest } from './graphStore.ts';
import { emptyZoneConnections, normalizeZoneConnections } from './zoneConnections.ts';

const poolId = import.meta.env.VITE_COGNITO_USER_POOL_ID || 'us-east-1_pQIUmVbPJ';
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID || '1osnrt38iuqvf5laum1tnj1hdn';
const pool = poolId && clientId ? new CognitoUserPool({ UserPoolId: poolId, ClientId: clientId }) : null;
const adminEmails = (import.meta.env.VITE_ADMIN_EMAILS || 'nj277@cornell.edu').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);

export const configured = Boolean(import.meta.env.VITE_GNARLY_API_BASE);
export const signInConfigured = Boolean(pool);

export type SessionUser = { uid: string; email: string; emailVerified: boolean };
export type DataRecord = { path: string; data: Record<string, unknown> };

let current: SessionUser | null = null;
const listeners = new Set<(user: SessionUser | null) => void>();

function emit() {
  for (const listener of listeners) listener(current);
}

function userFromSession(next: CognitoUserSession): SessionUser {
  const payload = next.getIdToken().payload;
  const email = typeof payload.email === 'string' ? payload.email : '';
  const verified = payload.email_verified === true || String(payload.email_verified) === 'true';
  return { uid: String(payload.sub || ''), email, emailVerified: verified };
}

function restore() {
  const user = pool?.getCurrentUser();
  if (!user) return;
  user.getSession((error: Error | null, next: CognitoUserSession | null) => {
    if (error || !next) return;
    current = userFromSession(next);
    emit();
  });
}
restore();

export function watchUser(callback: (user: SessionUser | null) => void) {
  callback(current);
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

export function useCanEdit() {
  return useSyncExternalStore(onChange => {
    const listener = () => onChange();
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, canEdit, () => false);
}

export function canEdit() {
  return Boolean(current?.emailVerified && adminEmails.includes(current.email.toLowerCase()));
}

export function currentEmail() {
  return current?.email || '';
}

export function login(email: string, password: string) {
  if (!pool) return Promise.reject(Error('Cognito is not configured.'));
  const username = email.trim();
  const user = new CognitoUser({ Username: username, Pool: pool });
  return new Promise<void>((resolve, reject) => {
    user.authenticateUser(new AuthenticationDetails({ Username: username, Password: password }), {
      onSuccess(next) {
        current = userFromSession(next);
        emit();
        resolve();
      },
      onFailure(error) {
        reject(Error(error?.message || 'Sign-in failed.'));
      },
      newPasswordRequired() {
        reject(Error('This account still has a temporary Cognito password. Set a permanent password in the user pool, then sign in again. This site does not create users.'));
      },
      mfaRequired() {
        reject(Error('This account requires MFA, which this form does not complete.'));
      },
    });
  });
}

export function logout() {
  pool?.getCurrentUser()?.signOut();
  current = null;
  emit();
}

function apiBase() {
  const base = import.meta.env.VITE_GNARLY_API_BASE?.replace(/\/$/, '');
  if (!base) throw Error('Set VITE_GNARLY_API_BASE to the publish API origin.');
  return base;
}

async function idToken() {
  const user = pool?.getCurrentUser();
  if (!user) return '';
  const next = await new Promise<CognitoUserSession>((resolve, reject) => {
    user.getSession((error: Error | null, value: CognitoUserSession | null) => error || !value ? reject(error || Error('Sign in again.')) : resolve(value));
  });
  current = userFromSession(next);
  return next.getIdToken().getJwtToken();
}

async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = await idToken().catch(() => '');
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(apiBase() + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as { error?: { message?: string } };
  if (!response.ok) throw Error(payload.error?.message || 'Publish API returned HTTP ' + response.status);
  return payload;
}

type SignedFile = { name: string; zoneId?: string; path: string; url: string };
type PackageZone = { zoneId: string; name?: string; floorId?: string; graphRevision?: string; files: SignedFile[] };
type PackageBody = {
  files?: SignedFile[];
  zones?: PackageZone[];
  layoutRevision?: string;
  connectionsRevision?: string;
  graphRevision?: string;
};
type VersionBody = {
  version: {
    buildingLayoutPath?: string | null;
    zoneConnectionsPath?: string | null;
    buildingJsonPath?: string | null;
    scanFeaturesPath?: string | null;
    structurePath?: string | null;
    webGraphRevision?: string;
    webBuildingLayoutRevision?: string;
    webZoneConnectionsRevision?: string;
  };
  zones: { id: string; webGraphRevision?: string; buildingJsonPath?: string }[];
};
type BuildingBody = { versions?: { id: string; versionNumber?: number }[] };

async function fetchUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw Error('Storage download returned HTTP ' + response.status);
  return response;
}

async function fetchUrlJSON(url: string) {
  return (await fetchUrl(url)).json();
}

async function fetchStorage(path: string) {
  const signed = await apiRequest('POST', '/v1/downloads', { path }) as { url?: string };
  if (!signed.url) throw Error('The publish API did not return a download URL.');
  return fetchUrl(signed.url);
}

export async function fetchStorageJSON(path: string): Promise<unknown> {
  return (await fetchStorage(path)).json();
}

async function loadSurfaceColors(jsonUrl: string, atlasUrl: string | undefined): Promise<SurfaceColors | undefined> {
  try {
    const raw = await fetchUrlJSON(jsonUrl) as {
      atlasWidth?: number; atlasHeight?: number;
      surfaces?: { identifier: string; faces: SurfaceColorFace[] }[];
    };
    if (!Array.isArray(raw.surfaces)) return undefined;
    const surfaces: SurfaceColors['surfaces'] = {};
    for (const surface of raw.surfaces) surfaces[surface.identifier] = Object.fromEntries((surface.faces || []).map(face => [face.face, face]));
    let objectUrl: string | undefined;
    if (raw.atlasWidth && raw.atlasHeight && atlasUrl) {
      try { objectUrl = URL.createObjectURL(await (await fetchUrl(atlasUrl)).blob()); } catch { objectUrl = undefined; }
    }
    return { atlasUrl: objectUrl, atlasWidth: raw.atlasWidth || 1, atlasHeight: raw.atlasHeight || 1, surfaces };
  } catch {
    return undefined;
  }
}

export function normalizeGraph(raw: unknown): Graph {
  if (!raw || typeof raw !== 'object') throw Error('Invalid navigation graph');
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.floors) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw Error('Building package has no usable navigation graph');
  }
  return {
    ...value,
    floors: value.floors as Graph['floors'],
    nodes: value.nodes.map((node: { id: string; floor?: string; floorId?: string; type: string; label?: string; position: Node['position'] | { x: number; y: number; z: number } }) => ({
      ...node,
      floor: node.floor || node.floorId || 'ground',
      position: Array.isArray(node.position) ? node.position : [node.position.x, node.position.y, node.position.z],
    })) as Node[],
    edges: value.edges as Graph['edges'],
  };
}

async function loadScan(url: string | undefined): Promise<{ scan?: ScanFeatures; error?: string }> {
  if (!url) return { error: 'No scan path' };
  try {
    const scan = await fetchUrlJSON(url) as ScanFeatures;
    if (Array.isArray(scan.walls) && Array.isArray(scan.floors)) return { scan };
    return { error: 'Invalid scan geometry JSON' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function fileNamed(files: SignedFile[] | undefined, name: string) {
  return files?.find(file => file.name === name);
}

export async function listBuildings(): Promise<Building[]> {
  if (!configured) return [];
  const payload = await apiRequest('GET', '/v1/buildings') as {
    buildings?: { id: string; name?: string; status?: string; activeVersion?: string | null; latitude?: number | null; longitude?: number | null }[];
  };
  return (payload.buildings || []).map(item => ({
    id: item.id,
    name: item.name || item.id,
    status: item.status || 'draft',
    activeVersion: item.activeVersion || null,
    lat: typeof item.latitude === 'number' ? item.latitude : undefined,
    lng: typeof item.longitude === 'number' ? item.longitude : undefined,
  }));
}

export async function loadBuilding(input: Building): Promise<Building> {
  if (!input.activeVersion) return { ...input, notice: 'No active map version is published.' };
  const versionId = input.activeVersion;
  let detail: VersionBody;
  let pack: PackageBody;
  try {
    [detail, pack] = await Promise.all([
      apiRequest('GET', `/v1/buildings/${encodeURIComponent(input.id)}/versions/${encodeURIComponent(versionId)}`) as Promise<VersionBody>,
      apiRequest('GET', `/v1/buildings/${encodeURIComponent(input.id)}/package?version=${encodeURIComponent(versionId)}`) as Promise<PackageBody>,
    ]);
  } catch (error) {
    return { ...input, notice: error instanceof Error ? error.message : String(error) };
  }
  const storageBase = 'buildings/' + input.id + '/' + versionId;
  const errors: string[] = [];
  const zones: ZoneView[] = [];
  for (const item of pack.zones || []) {
    const graphFile = fileNamed(item.files, 'building.json');
    const meta = detail.zones.find(zone => zone.id === item.zoneId);
    if (!graphFile) {
      errors.push(item.zoneId + ': building.json is missing');
      continue;
    }
    try {
      const graph = normalizeGraph(await fetchUrlJSON(graphFile.url));
      const scanFile = fileNamed(item.files, 'scan-features.json');
      const scanResult = await loadScan(scanFile?.url);
      const colorsFile = fileNamed(item.files, 'surface-colors.json');
      const atlasFile = fileNamed(item.files, 'surface-colors.jpg');
      const colors = scanResult.scan && colorsFile ? await loadSurfaceColors(colorsFile.url, atlasFile?.url) : undefined;
      const scan = scanResult.scan && colors ? { ...scanResult.scan, colors } : scanResult.scan;
      const raw = fileNamed(item.files, 'scan.json');
      const rawScanStatus = scan ? '' : raw ? ' Raw scan.json exists.' : ' Raw scan.json is also missing.';
      zones.push({
        id: item.zoneId,
        name: item.name || item.zoneId,
        floorId: item.floorId || graph.floors[0]?.id || 'ground',
        graph,
        graphPath: graphFile.path,
        graphRevision: meta?.webGraphRevision || item.graphRevision || '',
        scan,
        notice: scan ? (scan.colors ? 'RoomPlan scan geometry with real colors' : 'RoomPlan scan geometry') : 'Scan unavailable: ' + scanResult.error + rawScanStatus,
      });
    } catch (error) {
      errors.push(item.zoneId + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  const connectionsFile = fileNamed(pack.files, 'zone-connections.json');
  const layoutFile = fileNamed(pack.files, 'building-layout.json');
  const shared = {
    connectionsMetaPath: detail.version.zoneConnectionsPath || '',
    connectionsRevision: detail.version.webZoneConnectionsRevision || pack.connectionsRevision || '',
    layoutMetaPath: detail.version.buildingLayoutPath || '',
    layoutRevision: detail.version.webBuildingLayoutRevision || pack.layoutRevision || '',
    zoneConnectionsPath: connectionsFile?.path || detail.version.zoneConnectionsPath || storageBase + '/zone-connections.json',
    layoutPath: layoutFile?.path || detail.version.buildingLayoutPath || storageBase + '/building-layout.json',
  };
  if (zones.length) {
    const first = zones.find(zone => zone.scan) || zones[0];
    let zoneConnections = emptyZoneConnections();
    if (connectionsFile) {
      try { zoneConnections = normalizeZoneConnections(await fetchUrlJSON(connectionsFile.url)); }
      catch (error) { errors.push('zone-connections.json: ' + (error instanceof Error ? error.message : String(error))); }
    }
    let layout: Building['layout'];
    if (layoutFile) {
      try {
        const raw = await fetchUrlJSON(layoutFile.url) as Building['layout'];
        if (raw?.schemaVersion === 1 && Array.isArray(raw.zones)) layout = raw;
      } catch (error) {
        errors.push('building-layout.json: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    return {
      ...input,
      ...shared,
      zoneId: first.id,
      zones,
      graph: first.graph,
      graphPath: first.graphPath,
      graphRevision: first.graphRevision,
      scan: first.scan,
      zoneConnections,
      layout,
      notice: first.scan
        ? 'Showing RoomPlan geometry from zone ' + first.name + '. ' + zones.length + ' zone(s) available.'
        : zones.length + ' zone(s) found, but none has readable scan-features.json. ' + zones.map(zone => zone.id + ': ' + zone.notice).join('; '),
    };
  }
  const graphFile = fileNamed(pack.files, 'building.json');
  if (!graphFile) {
    const zoneReason = errors.length ? ' Zone errors: ' + errors.join('; ') : '';
    return { ...input, ...shared, notice: 'Building package unavailable.' + zoneReason };
  }
  try {
    const graph = normalizeGraph(await fetchUrlJSON(graphFile.url));
    const scanFile = fileNamed(pack.files, 'scan-features.json');
    const scanResult = await loadScan(scanFile?.url);
    return {
      ...input,
      ...shared,
      graph,
      graphPath: graphFile.path,
      graphRevision: detail.version.webGraphRevision || pack.graphRevision || '',
      scan: scanResult.scan,
      structurePath: detail.version.structurePath,
      notice: scanResult.scan ? 'Showing RoomPlan geometry.' : 'No scan geometry uploaded yet; showing graph-based layout.',
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const zoneReason = errors.length ? ' Zone errors: ' + errors.join('; ') : '';
    return { ...input, ...shared, notice: 'Building package unavailable: ' + reason + zoneReason };
  }
}

export async function loadPreviousBuildingVersion(input: Building): Promise<Building> {
  if (!configured) return { ...input, notice: 'The publish API is not configured.' };
  const detail = await apiRequest('GET', '/v1/buildings/' + encodeURIComponent(input.id)) as BuildingBody;
  const candidates = (detail.versions || [])
    .filter(item => item.id !== input.activeVersion)
    .sort((a, b) => Number(b.versionNumber || 0) - Number(a.versionNumber || 0));
  for (const candidate of candidates) {
    const result = await loadBuilding({ ...input, activeVersion: candidate.id });
    if (result.graph) {
      return {
        ...result,
        viewingPreviousVersion: true,
        notice: 'Viewing previous version ' + candidate.id + '. Current active version ' + input.activeVersion + ' is unavailable. ' + (result.notice || ''),
      };
    }
  }
  return { ...input, notice: 'No earlier version with a usable building package was found.' };
}

async function uploadJson(path: string, value: unknown) {
  const body = JSON.stringify(value);
  const size = new TextEncoder().encode(body).length;
  const signed = await apiRequest('POST', '/v1/uploads', { path, contentType: 'application/json', size }) as { url?: string; headers?: Record<string, string> };
  if (!signed.url) throw Error('The publish API did not return an upload URL.');
  const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body });
  if (!response.ok) throw Error('Upload failed (HTTP ' + response.status + ').');
}

async function movePointer(building: Building, body: Record<string, unknown>) {
  await apiRequest('POST', '/v1/buildings/' + encodeURIComponent(building.id) + '/pointers', body);
}

export async function saveZoneConnections(input: Building, document: ZoneConnections): Promise<ZoneConnections> {
  if (!input.activeVersion || !canEdit()) throw Error('This account cannot edit zone connections.');
  const normalized = normalizeZoneConnections(document);
  const path = input.zoneConnectionsPath || 'buildings/' + input.id + '/' + input.activeVersion + '/zone-connections.json';
  const revision = crypto.randomUUID();
  await uploadJson(path, normalized);
  await movePointer(input, {
    versionId: input.activeVersion,
    kind: 'connections',
    path,
    marker: revision,
    expectedPath: input.connectionsMetaPath || '',
    expectedMarker: input.connectionsRevision || '',
  });
  input.zoneConnectionsPath = path;
  input.connectionsMetaPath = path;
  input.connectionsRevision = revision;
  return normalized;
}

export async function saveBuildingLayout(input: Building, document: BuildingLayout): Promise<BuildingLayout> {
  if (!input.activeVersion || !canEdit()) throw Error('This account cannot edit building layout.');
  if (document.schemaVersion !== 1 || !Array.isArray(document.zones)) throw Error('Invalid building layout.');
  for (const zone of document.zones) {
    if (!zone.zoneId || ![zone.floor, zone.x, zone.z, zone.rotationDegrees].every(Number.isFinite)) throw Error('Each zone needs a finite floor, X, Z, and rotation.');
  }
  const normalized: BuildingLayout = { schemaVersion: 1, zones: document.zones.map(zone => ({ ...zone })), ...(document.floors ? { floors: document.floors.map(floor => ({ ...floor })) } : {}), ...(document.notes ? { notes: document.notes } : {}) };
  const path = input.layoutPath || 'buildings/' + input.id + '/' + input.activeVersion + '/building-layout.json';
  const revision = crypto.randomUUID();
  await uploadJson(path, normalized);
  await movePointer(input, {
    versionId: input.activeVersion,
    kind: 'layout',
    path,
    marker: revision,
    expectedPath: input.layoutMetaPath || '',
    expectedMarker: input.layoutRevision || '',
  });
  input.layoutPath = path;
  input.layoutMetaPath = path;
  input.layoutRevision = revision;
  return normalized;
}

export async function listDataRecords(): Promise<DataRecord[]> {
  if (!configured) return [];
  const payload = await apiRequest('GET', '/v1/records') as { records?: DataRecord[] };
  return payload.records || [];
}

export async function saveDataRecord(path: string, before: Record<string, unknown>, after: Record<string, unknown>) {
  if (!canEdit()) throw Error('This account cannot edit project data.');
  if (!after || typeof after !== 'object' || Array.isArray(after)) throw Error('Document JSON must be an object.');
  await apiRequest('PUT', '/v1/records', { path, before, after });
}

export async function loadStorageData(path: string): Promise<unknown> {
  return fetchStorageJSON(path);
}

export function createCloudGraphStore(input: Building): import('./graphStore.ts').GraphStore {
  if (!input.activeVersion || !input.graph) throw Error('Cloud graph is unavailable.');
  const versionId = input.activeVersion;
  const zoneId = input.zoneId || '';
  const fallbackPath = input.graphPath || 'buildings/' + input.id + '/' + versionId + (zoneId ? '/zones/' + zoneId : '') + '/building.json';
  const load = async (): Promise<import('./graphStore.ts').GraphSnapshot> => {
    const detail = await apiRequest('GET', `/v1/buildings/${encodeURIComponent(input.id)}/versions/${encodeURIComponent(versionId)}`) as VersionBody;
    const zone = zoneId ? detail.zones.find(item => item.id === zoneId) : undefined;
    const stored = String((zone ? zone.buildingJsonPath : detail.version.buildingJsonPath) || '');
    const fetchPath = stored || fallbackPath;
    const marker = String((zone ? zone.webGraphRevision : detail.version.webGraphRevision) || '');
    const graph = normalizeGraph(await fetchStorageJSON(fetchPath));
    return { graph, revision: fetchPath + ':' + graphDigest(graph), path: stored, remoteMarker: marker, source: 'cloud' };
  };
  return {
    load,
    async save(graph, expected) {
      if (!canEdit()) throw Error('This account cannot edit the map.');
      const id = crypto.randomUUID();
      const base = 'buildings/' + input.id + '/' + versionId + (zoneId ? '/zones/' + zoneId : '');
      const path = base + '/graph-edits/' + id + '.json';
      await uploadJson(path, graph);
      await movePointer(input, {
        versionId,
        ...(zoneId ? { zoneId } : {}),
        kind: 'graph',
        path,
        marker: id,
        expectedPath: expected.path || '',
        expectedMarker: expected.remoteMarker || '',
      });
      return { graph, revision: path + ':' + graphDigest(graph), path, remoteMarker: id, source: 'cloud' };
    },
    subscribe(onChange, onError) {
      let disposed = false;
      let lastRevision = '';
      let request = 0;
      const check = async () => {
        const currentRequest = ++request;
        try {
          const snapshot = await load();
          if (!disposed && currentRequest === request && snapshot.revision !== lastRevision) {
            lastRevision = snapshot.revision;
            onChange(snapshot);
          }
        } catch (error) {
          if (!disposed && currentRequest === request) onError(error instanceof Error ? error : Error(String(error)));
        }
      };
      const interval = window.setInterval(() => void check(), 15000);
      return () => { disposed = true; window.clearInterval(interval); };
    },
  };
}
