// SPDX-License-Identifier: AGPL-3.0-only
// electron-builder afterPack hook: force an ad-hoc signature on macOS builds.
// electron-builder skips signing when no Developer ID certificate is present,
// but unsigned arm64 binaries will not launch on Apple Silicon.
const { execSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${appName}.app`)
  // "-" is the ad-hoc signing identity; --deep covers embedded frameworks/helpers.
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
  console.log(`after-pack: ad-hoc signed ${appPath}`)
}
