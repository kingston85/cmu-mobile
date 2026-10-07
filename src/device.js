// Phone features: camera, GPS, CSV export/share, session storage.
import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Geolocation } from '@capacitor/geolocation';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Preferences } from '@capacitor/preferences';

export const isNative = () => Capacitor.isNativePlatform();

// ---------- session ----------
export async function loadSession() {
  const { value } = await Preferences.get({ key: 'session' });
  return value ? JSON.parse(value) : null;
}
export const saveSession = s => Preferences.set({ key: 'session', value: JSON.stringify(s) });
export const clearSession = () => Preferences.remove({ key: 'session' });

// ---------- camera ----------
function resizeDataUrl(dataUrl, maxW = 1280, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', quality).split(',')[1]);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function pickFileAsDataUrl() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return reject(new Error('cancelled'));
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(f);
    };
    input.click();
  });
}

/** Returns base64 JPEG (no data: prefix), ~150–300 KB */
export async function takePhoto() {
  if (isNative()) {
    const p = await Camera.getPhoto({
      quality: 60, width: 1280, correctOrientation: true,
      resultType: CameraResultType.Base64, source: CameraSource.Prompt,
      promptLabelHeader: 'Inspection photo', promptLabelPhoto: 'From gallery', promptLabelPicture: 'Take photo',
    });
    return p.base64String;
  }
  return resizeDataUrl(await pickFileAsDataUrl());
}

// ---------- GPS ----------
export async function getGps() {
  if (isNative()) {
    const perm = await Geolocation.checkPermissions();
    if (perm.location !== 'granted') await Geolocation.requestPermissions();
  }
  const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  return {
    lat: Number(pos.coords.latitude.toFixed(6)),
    lng: Number(pos.coords.longitude.toFixed(6)),
    gps_accuracy_m: Math.round(pos.coords.accuracy),
  };
}

// ---------- CSV export ----------
const esc = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(rows, columns) {
  return [columns.map(c => esc(c.label)).join(','), ...rows.map(r => columns.map(c => esc(c.value(r))).join(','))].join('\n');
}

export async function shareCsv(filename, csv) {
  if (isNative()) {
    const res = await Filesystem.writeFile({ path: filename, data: csv, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: filename, files: [res.uri], dialogTitle: 'Share CMU export' });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
}
