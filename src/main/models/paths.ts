import { app } from 'electron'
import { join } from 'path'

/**
 * Directory where downloaded AI models are cached.
 *
 * User requirement: keep models INSIDE the project/app folder, NOT on the C: drive userData
 * path that the plan originally specified. In dev, `app.getAppPath()` is the project root.
 * (Packaging in Phase 6 must revisit this, since the app dir is read-only inside the asar.)
 */
export function getModelsDir(): string {
  return join(app.getAppPath(), 'models')
}
