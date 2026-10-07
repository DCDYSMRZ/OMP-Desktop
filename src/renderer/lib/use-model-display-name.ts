import { useSyncExternalStore } from 'react';
import { modelDisplayName, modelNames } from '../../shared/model-display-name';

export function useModelDisplayName() {
  useSyncExternalStore(modelNames.subscribe, modelNames.getSnapshot, modelNames.getSnapshot);
  return modelDisplayName;
}
