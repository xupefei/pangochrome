# Pangochrome privacy policy

Pangochrome is open-source software: https://github.com/xupefei/pangochrome.
It has two parts: the Chrome extension and a helper program that runs on your
computer. The Pangochrome project runs no servers. It receives no data from
you, and it has no analytics, advertising or tracking.

## Data that stays on your computer

The extension keeps these values in Chrome's local extension storage:

- A random profile ID. The helper uses it to keep each Chrome profile's login
  apart.
- Whether you turned the connection on.
- The Pangolin host names and IPv4 ranges of your last connection, and whether
  you chose an exit node. The extension uses them to block that traffic while
  the tunnel is down, so it does not go out directly.

The helper keeps these values in `~/.config/pangochrome` on Linux and in
`~/Library/Application Support/pangochrome` on macOS. Only your user account
can read the account file.

- The address of your Pangolin server.
- Your Pangolin session token, user ID, email address and name.
- The organisation and exit nodes that you chose.
- The device credentials that your Pangolin server issued for this browser
  profile.
- A log file, `helper.log`. It can contain the host names of connections that
  failed.

The proxy credentials between the extension and the helper exist only in
memory.

## Data that leaves your computer

Pangochrome sends data only to the Pangolin server that you choose, and
through the encrypted tunnel to the Pangolin sites of your organisation:

- To log in, register this browser profile as a device, and list your
  organisations and exit nodes, the helper calls your Pangolin server's API.
  At registration it sends a device name (your computer's host name followed
  by "(Pangochrome)"), the operating system, the CPU type and the host name.
- While you are connected, the helper keeps a control connection to your
  Pangolin server.
- Browser requests for your Pangolin resources go through the tunnel to your
  sites.
- If you turn on an exit node, all other browser traffic goes through the
  tunnel to that site and out to the internet from there. The helper then
  resolves public host names with the DNS servers 1.1.1.1 and 8.8.8.8,
  through the same tunnel.

All other browser traffic goes directly, as without Pangochrome. Pangochrome
does not record your browsing history, and it does not read or change the
content of web pages.

Your Pangolin server operator handles your data under their own policy. For
Pangolin Cloud, see https://pangolin.net.

## Remove your data

- In the popup, click **Log out**. The helper ends the session on your server
  and deletes the session token. The device registration stays, so your next
  login reuses it. To remove the device, delete it in your Pangolin dashboard.
- To remove the helper and its registration, run the install command from the
  popup with `--uninstall`, then delete the helper's directory above.
- Removing the extension deletes its local storage.

## Contact

Open an issue at https://github.com/xupefei/pangochrome/issues.
