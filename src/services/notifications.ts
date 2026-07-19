import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { isTauri } from "./native";

export async function notificationsAreEnabled(): Promise<boolean> {
  if (!isTauri()) return false;
  return isPermissionGranted();
}

export async function enableNotifications(): Promise<boolean> {
  if (!isTauri()) return false;
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
}

export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri() || !(await isPermissionGranted())) return;
  sendNotification({ title, body });
}
