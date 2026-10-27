export interface PictureInPictureCloseSyncInput {
  enabled: boolean;
  open: boolean;
  wasOpen: boolean;
  closeReason?: string;
}

export interface PictureInPictureCloseSyncResult {
  nextWasOpen: boolean;
  disablePresentation: boolean;
}

export function reconcilePictureInPictureClose(
  input: PictureInPictureCloseSyncInput
): PictureInPictureCloseSyncResult {
  if (input.open) {
    return { nextWasOpen: true, disablePresentation: false };
  }
  if (!input.enabled) {
    return { nextWasOpen: false, disablePresentation: false };
  }
  if (!input.wasOpen || input.closeReason === "renderer-reload") {
    return { nextWasOpen: false, disablePresentation: false };
  }
  return { nextWasOpen: false, disablePresentation: true };
}
