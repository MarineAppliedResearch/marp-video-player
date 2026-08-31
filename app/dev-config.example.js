/**
 * Optional local prefill for manual testing. Copy to app/dev-config.js, which
 * is git-ignored, and fill in your own dev server details.
 *
 *     <script src="dev-config.js"></script>   <!-- before app.js -->
 *
 * Never commit real credentials.
 */
window.MARP_DEV_CONFIG = {
    jellyfin: {
        serverUrl: "http://your-dev-jellyfin:8096",
        username: "",
        password: "",
    },
    itemId: "",
};
