/**
 * KataGo Web — Admin panel logic
 */

(function () {
    "use strict";

    const TOKEN_KEY    = "jwt_token";
    const USERNAME_KEY = "jwt_username";

    function getToken()    { return localStorage.getItem(TOKEN_KEY); }
    function getUsername() { return localStorage.getItem(USERNAME_KEY); }

    function saveAuth(token, username) {
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.setItem(USERNAME_KEY, username);
    }

    function clearAuth() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USERNAME_KEY);
    }

    function authHeaders() {
        return {
            "Content-Type":  "application/json",
            "Authorization": "Bearer " + (getToken() || ""),
        };
    }

    // ── Auth gate ─────────────────────────────────────────────────────────────

    async function checkAdminAccess() {
        const token = getToken();
        if (!token) { showGate(); return; }

        // Verify the token is still valid and belongs to an admin
        try {
            const res = await fetch("/api/admin/users", {
                headers: authHeaders(),
            });
            if (res.status === 401 || res.status === 403) {
                showGate();
            } else {
                showAdminUI();
            }
        } catch {
            showGate();
        }
    }

    function showGate() {
        document.getElementById("admin-auth-gate").style.display = "flex";
        document.getElementById("admin-main").style.display       = "none";
        document.getElementById("gate-password").focus();
    }

    function showAdminUI() {
        document.getElementById("admin-auth-gate").style.display = "none";
        document.getElementById("admin-main").style.display       = "block";
        document.getElementById("admin-username").textContent     = getUsername() || "admin";
        loadAll();
    }

    document.getElementById("gate-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const username = document.getElementById("gate-username").value.trim();
        const password = document.getElementById("gate-password").value;
        const errEl    = document.getElementById("gate-error");

        try {
            const res  = await fetch("/api/login", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ username, password }),
            });
            const data = await res.json();
            if (!res.ok) {
                errEl.textContent    = data.error || "Login failed";
                errEl.style.display  = "block";
                return;
            }
            saveAuth(data.token, data.username);

            // Verify this account is actually admin
            const chk = await fetch("/api/admin/users", { headers: authHeaders() });
            if (chk.status === 403) {
                clearAuth();
                errEl.textContent   = "This account does not have admin privileges";
                errEl.style.display = "block";
                return;
            }
            errEl.style.display = "none";
            showAdminUI();
        } catch (err) {
            errEl.textContent   = "Network error: " + err.message;
            errEl.style.display = "block";
        }
    });

    document.getElementById("btn-logout").addEventListener("click", () => {
        clearAuth();
        showGate();
    });

    // ── Load everything ───────────────────────────────────────────────────────

    function loadAll() {
        loadUsers();
        loadSettings();
    }

    // ── Users ─────────────────────────────────────────────────────────────────

    async function loadUsers() {
        const tbody = document.getElementById("user-tbody");
        try {
            const res   = await fetch("/api/admin/users", { headers: authHeaders() });
            const data  = await res.json();
            const users = data.users || [];

            document.getElementById("user-count").textContent = users.length + " user" + (users.length !== 1 ? "s" : "");

            if (users.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">No users</td></tr>';
                return;
            }

            tbody.innerHTML = users.map((u) => `
                <tr data-username="${u.username}">
                    <td class="cell-id">${u.id}</td>
                    <td class="cell-username">${escHtml(u.username)}</td>
                    <td class="cell-role">
                        ${u.is_admin
                            ? '<span class="role-badge admin">admin</span>'
                            : '<span class="role-badge user">user</span>'}
                    </td>
                    <td class="cell-action">
                        ${u.is_admin
                            ? '<span class="protected-label">protected</span>'
                            : `<button class="btn-delete" data-username="${escHtml(u.username)}">Delete</button>`}
                    </td>
                </tr>`).join("");

            tbody.querySelectorAll(".btn-delete").forEach((btn) => {
                btn.addEventListener("click", () => confirmDelete(btn.dataset.username));
            });
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="4" class="error-cell">Error: ${err.message}</td></tr>`;
        }
    }

    async function confirmDelete(username) {
        if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
        try {
            const res  = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
                method:  "DELETE",
                headers: authHeaders(),
            });
            const data = await res.json();
            if (res.ok) {
                showToast(`User "${username}" deleted`);
                loadUsers();
            } else {
                showToast(data.error || "Delete failed", true);
            }
        } catch (err) {
            showToast("Network error: " + err.message, true);
        }
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    async function loadSettings() {
        try {
            const res  = await fetch("/api/admin/settings", { headers: authHeaders() });
            const data = await res.json();
            document.getElementById("toggle-registration").checked = !!data.registration_open;
        } catch { /* ignore */ }
    }

    document.getElementById("toggle-registration").addEventListener("change", async (e) => {
        try {
            const res = await fetch("/api/admin/settings", {
                method:  "PATCH",
                headers: authHeaders(),
                body:    JSON.stringify({ registration_open: e.target.checked }),
            });
            if (res.ok) {
                showToast("Registration " + (e.target.checked ? "opened" : "closed"));
            } else {
                e.target.checked = !e.target.checked; // revert
                showToast("Failed to update setting", true);
            }
        } catch {
            e.target.checked = !e.target.checked;
            showToast("Network error", true);
        }
    });

    // ── Change password ───────────────────────────────────────────────────────

    document.getElementById("change-pw-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const oldPw  = document.getElementById("old-password").value;
        const newPw  = document.getElementById("new-password").value;
        const confPw = document.getElementById("confirm-password").value;
        const msgEl  = document.getElementById("pw-message");

        msgEl.className    = "form-message";
        msgEl.style.display = "block";

        if (newPw !== confPw) {
            msgEl.textContent = "New passwords do not match";
            msgEl.classList.add("error");
            return;
        }
        if (newPw.length < 6) {
            msgEl.textContent = "New password must be at least 6 characters";
            msgEl.classList.add("error");
            return;
        }

        try {
            const res  = await fetch("/api/admin/change-password", {
                method:  "POST",
                headers: authHeaders(),
                body:    JSON.stringify({ old_password: oldPw, new_password: newPw }),
            });
            const data = await res.json();
            if (res.ok) {
                msgEl.textContent = "Password updated successfully";
                msgEl.classList.add("success");
                document.getElementById("change-pw-form").reset();
            } else {
                msgEl.textContent = data.error || "Update failed";
                msgEl.classList.add("error");
            }
        } catch (err) {
            msgEl.textContent = "Network error: " + err.message;
            msgEl.classList.add("error");
        }
    });

    // ── Helpers ───────────────────────────────────────────────────────────────

    function escHtml(str) {
        return str.replace(/[&<>"']/g, (c) =>
            ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
    }

    let _toastTimer = null;
    function showToast(msg, isError = false) {
        let toast = document.getElementById("admin-toast");
        if (!toast) {
            toast = document.createElement("div");
            toast.id = "admin-toast";
            document.body.appendChild(toast);
        }
        toast.textContent  = msg;
        toast.className    = "admin-toast " + (isError ? "error" : "success");
        toast.style.display = "block";
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => { toast.style.display = "none"; }, 3000);
    }

    // ── Entry point ───────────────────────────────────────────────────────────

    window.addEventListener("DOMContentLoaded", checkAdminAccess);

})();
