/** The standalone local-play entry. It deliberately mounts only the game page: no router, account
 * provider, authenticated shell, or production API bootstrap belongs in the loopback bundle. */
import { createApp } from 'vue'

import LocalPlayPage from './LocalPlayPage.vue'
import '../renderers/index.js'
import '../styles/tokens.css'
import '../styles/base.css'
import '../styles/app.css'
import '../styles/season-rows.css'

const root = document.getElementById('app')
if (root === null) {
  throw new Error('missing #app element')
}

createApp(LocalPlayPage).mount(root)
