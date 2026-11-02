import { BASE_URL, getFreshBrowserCsrfToken } from "./http"

/**
 * Submit Cloud logout as a top-level form navigation.
 *
 * The gateway response clears the browser cookies, broadcasts logout to other
 * tabs, and redirects through WorkOS. Fetching this endpoint would only return
 * that navigation document without executing it, so this deliberately uses a
 * real form submission instead of authenticatedFetch.
 */
export async function submitCloudLogout(): Promise<void> {
  let csrfToken: string | null = null
  try {
    // Another tab may have completed a new login since this SPA cached a token
    // for an earlier mutation, so logout must bind itself to the current cookie
    // session instead of reusing that module cache.
    csrfToken = await getFreshBrowserCsrfToken()
  } catch {
    // The gateway-owned GET page can still recover a stale or temporarily
    // unreadable session and render its own deliberate confirmation.
  }

  if (!csrfToken) {
    window.location.assign(`${BASE_URL}/logout`)
    return
  }

  const form = document.createElement("form")
  form.hidden = true
  form.method = "post"
  form.action = `${BASE_URL}/logout`

  const csrf = document.createElement("input")
  csrf.type = "hidden"
  csrf.name = "csrf"
  csrf.value = csrfToken
  form.append(csrf)
  document.body.append(form)

  try {
    form.requestSubmit()
  } catch {
    form.remove()
    window.location.assign(`${BASE_URL}/logout`)
  }
}
