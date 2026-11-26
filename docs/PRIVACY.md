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

The helper keeps these values in `~/Library/Application Support/pangochrome`
on macOS, and in `$XDG_CONFIG_HOME/pangochrome` (by default
`~/.config/pangochrome`) on Linux. It creates its files with mode 0600, so
only your user account can read them.

- The address of your Pangolin server.
- Your Pangolin session token, user ID, email address and name.
- The organisation and exit nodes that you chose.
- The device credentials that your Pangolin server issued for this browser
  profile.
- The WireGuard private key of this browser profile's device. The helper keeps
  it between connections; it never leaves your computer.
- A log file, `helper.log`. It records connection events of the Pangolin
  client: site names and IDs, endpoint addresses, public keys and DNS
  settings. It also records the host names of connections that failed. With
  an exit node on, those can be public websites. If you create a file named
  `debug` next to it, the log also gets the Pangolin client's debug messages,
  with secrets left out.

The proxy credentials between the extension and the helper exist only in
memory.

## Data that leaves your computer

Pangochrome sends data only to the Pangolin server that you choose, and
through the encrypted tunnel to the Pangolin sites of your organisation:

- To log in, register this browser profile as a device, and list your
  organisations and exit nodes, the helper calls your Pangolin server's API.
  The device name that it registers is your computer's host name followed by
  "(Pangochrome)".
- While you are connected, the helper keeps a control connection to your
  Pangolin server. When the tunnel starts, and in each keep-alive message,
  it sends the operating system, the CPU type, the host name, the name
  "Pangochrome" and the helper version. When the tunnel starts, it also
  sends how fast it reached each Pangolin relay server.
- Browser requests for your Pangolin resources go through the tunnel to your
  sites.
- If you turn on an exit node, all other browser traffic goes through the
  tunnel to that site and out to the internet from there. The helper then
  resolves public host names with the DNS servers 1.1.1.1 and 8.8.8.8,
  through the same tunnel.

All other browser traffic goes directly, as without Pangochrome. Pangochrome
does not read or change the content of web pages.

Your Pangolin server operator handles your data under their own policy. For
Pangolin Cloud, see https://pangolin.net.

## Remove your data

- In the popup, click **Log out**. The helper ends the session on your server
  and deletes the session token. The device registration stays, so your next
  login reuses it. To remove the device, delete it in your Pangolin dashboard.
- Log out before you remove the extension. Otherwise the session token stays
  in the helper's directory, and your server still accepts it.
- To remove the helper and its browser registrations, run:

  ```sh
  curl -fsSL https://github.com/xupefei/pangochrome/releases/latest/download/install.sh | sh -s -- --uninstall
  ```

  Then delete the helper's directory above.
- Removing the extension deletes its local storage.

## Contact

Open an issue at https://github.com/xupefei/pangochrome/issues.
