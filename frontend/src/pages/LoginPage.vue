<!--
  The sign-in page at /login. It carries both sign-in methods the deployment offers — email and
  password always, "Sign in with GitHub" only when the deployment configured GitHub OAuth (the
  `github_auth` flag on GET /api/config, read through useSiteConfig). Both paths establish the Better
  Auth session cookie and then do a full-page navigation to `/`, which re-runs the one /api/me fetch
  in me.ts rather than threading a reactive session refresh through the provider.

  There is no registration: accounts come from GitHub sign-in, the seeded admin, or an admin creating
  one. A visitor who is already signed in is bounced to `/` so the page is never a dead end for them.
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { authClient } from '../auth.js'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiField from '../components/ui/UiField.vue'
import UiInput from '../components/ui/UiInput.vue'
import { useSiteConfig } from '../composables/useSiteConfig.js'
import { useMe } from '../me.js'

const me = useMe()
const { githubAuth } = useSiteConfig()

// Hold the form back until the one /api/me answer settles: an already-signed-in visitor is redirected
// rather than shown a form they don't need (which would then bounce and flicker).
const checking = ref(true)
const email = ref('')
const password = ref('')
const submitting = ref(false)
const errorMessage = ref<string | null>(null)

onMounted(async () => {
  await me.whenSettled()
  if (me.me?.user != null) {
    window.location.assign('/')
    return
  }
  checking.value = false
})

async function onSubmit(): Promise<void> {
  if (checking.value || submitting.value) {
    return
  }
  submitting.value = true
  errorMessage.value = null
  try {
    const { error } = await authClient.signIn.email({ email: email.value, password: password.value })
    if (error) {
      // Better Auth returns a human-readable message for both a wrong credential and a banned account;
      // surface it directly, with a generic fallback if one is somehow absent.
      errorMessage.value = error.message ?? 'Could not sign you in. Please try again.'
      return
    }
    // A full navigation re-runs the single /api/me fetch, so the shell renders the new session.
    window.location.assign('/')
  } catch {
    errorMessage.value = 'Could not reach the sign-in service. Please try again.'
  } finally {
    submitting.value = false
  }
}

async function signInWithGithub(): Promise<void> {
  errorMessage.value = null
  try {
    // On success this redirects to GitHub; only a failure to start the flow returns here.
    const { error } = await authClient.signIn.social({ provider: 'github', callbackURL: '/' })
    if (error) {
      errorMessage.value = error.message ?? 'Could not start GitHub sign-in. Please try again.'
    }
  } catch {
    errorMessage.value = 'Could not reach the sign-in service. Please try again.'
  }
}
</script>

<template>
  <section class="login">
    <UiCard class="login-card">
      <h1 class="login-title">Sign in</h1>
      <p class="login-lede">Sign in to start sessions, submit agents, and rate.</p>

      <form class="login-form" @submit.prevent="onSubmit">
        <UiField label="Email">
          <template #default="{ id, describedby }">
            <UiInput
              :id="id"
              v-model="email"
              type="email"
              autocomplete="email"
              placeholder="you@example.com"
              :aria-describedby="describedby"
            />
          </template>
        </UiField>

        <UiField label="Password">
          <template #default="{ id, describedby }">
            <UiInput
              :id="id"
              v-model="password"
              type="password"
              autocomplete="current-password"
              :aria-describedby="describedby"
            />
          </template>
        </UiField>

        <p v-if="errorMessage !== null" class="login-error" role="alert">{{ errorMessage }}</p>

        <UiButton type="submit" :loading="submitting" :disabled="checking">Sign in</UiButton>
      </form>

      <template v-if="githubAuth">
        <div class="login-divider"><span>or</span></div>
        <UiButton variant="secondary" :disabled="checking" @click="signInWithGithub">
          Sign in with GitHub
        </UiButton>
      </template>

      <p class="login-note">
        Reach out to the site administrator to register.
      </p>
    </UiCard>
  </section>
</template>

<style scoped>
.login {
  display: flex;
  justify-content: center;
  padding: var(--space-6) var(--space-4);
}

.login-card {
  width: 100%;
  max-width: 24rem;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.login-title {
  margin: 0;
}

.login-lede {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.login-error {
  margin: 0;
  color: var(--color-danger);
  font-size: var(--text-sm);
}

.login-divider {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.login-divider::before,
.login-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--color-border);
}

.login-note {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
</style>
