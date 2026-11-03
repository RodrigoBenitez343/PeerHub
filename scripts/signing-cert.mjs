import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Make sure this machine can sign the Windows build, as the person who ships it.
//
// The signature is only as good as the certificate behind it, so the identity is
// deliberately not a placeholder: a self-signed code-signing certificate with
// CN=Rodrigo David Benitez is created once in the user's certificate store and
// reused by every later build. electron-builder finds it by subject name
// (`win.certificateSubjectName` in electron-builder.yml) and signs the app
// executable, the uninstaller and the installer.
//
// A self-signed certificate proves who built the file to anyone who has the
// certificate; Windows still calls the publisher unrecognised on a machine that
// has not trusted it. Installing the certificate into "Trusted Root Certification
// Authorities" or buying a code-signing certificate and setting CSC_LINK are the
// two ways to change that — neither is done here.
//
// Nothing secret is written to the repository: the private key stays in the
// certificate store (exportable, so `--export` can hand a bundle to CI).

const SUBJECT = 'CN=Rodrigo David Benitez, O=PeerHub';
const NAME = 'Rodrigo David Benitez';
const EXPORT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.certs');

function powershell(script) {
	const file = path.join(os.tmpdir(), `peerhub-cert-${process.pid}.ps1`);
	fs.writeFileSync(file, script, 'utf8');
	try {
		return execFileSync(
			'powershell',
			['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
			{ encoding: 'utf8', windowsHide: true }
		);
	} finally {
		fs.rmSync(file, { force: true });
	}
}

const FIND_OR_CREATE = `
$ErrorActionPreference = 'Stop'
$subject = '${SUBJECT}'
$cert = Get-ChildItem Cert:\\CurrentUser\\My |
	Where-Object {
		$_.Subject -eq $subject -and $_.HasPrivateKey -and
		$_.NotAfter -gt (Get-Date).AddDays(30)
	} |
	Sort-Object NotAfter -Descending |
	Select-Object -First 1
$state = 'existing'
if (-not $cert) {
	$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject \`
		-KeyUsage DigitalSignature -KeyExportPolicy Exportable -KeyLength 3072 \`
		-HashAlgorithm SHA256 -CertStoreLocation Cert:\\CurrentUser\\My \`
		-NotAfter (Get-Date).AddYears(5)
	$state = 'created'
}
Write-Output ('{0}|{1}|{2}|{3}' -f $state, $cert.Thumbprint, $cert.Subject, $cert.NotAfter.ToString('yyyy-MM-dd'))
`;

const EXPORT_PFX = (file, password) => `
$ErrorActionPreference = 'Stop'
$cert = Get-ChildItem Cert:\\CurrentUser\\My |
	Where-Object { $_.Subject -eq '${SUBJECT}' -and $_.HasPrivateKey } |
	Sort-Object NotAfter -Descending |
	Select-Object -First 1
if (-not $cert) { throw 'no ${NAME} certificate in Cert:\\CurrentUser\\My' }
$secure = ConvertTo-SecureString -String '${password}' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath '${file}' -Password $secure | Out-Null
Write-Output $cert.Thumbprint
`;

function main() {
	const args = process.argv.slice(2);

	// CI has no certificate store; it is given one explicitly, and electron-builder
	// uses CSC_LINK ahead of any subject name.
	if (process.env.CSC_LINK) {
		console.log('[sign] CSC_LINK is set — electron-builder signs with that certificate');
		return;
	}

	// The Windows targets are the only ones electron-builder can sign here; macOS
	// would need a Developer ID, which is a purchase, not a script.
	if (process.platform !== 'win32') {
		console.log(`[sign] no code-signing certificate on ${process.platform}: the build is unsigned`);
		return;
	}

	const exportIndex = args.indexOf('--export');
	if (exportIndex !== -1) {
		const file = args[exportIndex + 1] ?? path.join(EXPORT_DIR, 'peerhub.pfx');
		const password = args[args.indexOf('--password') + 1] ?? '';
		if (args.includes('--password') && !password) {
			console.error('[sign] --password needs a value');
			process.exit(1);
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		try {
			const thumbprint = powershell(EXPORT_PFX(toPosix(file), password)).trim();
			console.log(`[sign] exported ${thumbprint} to ${file}`);
			console.log('[sign] keep it out of git; set CSC_LINK / CSC_KEY_PASSWORD for CI');
			return;
		} catch (err) {
			console.error(`[sign] export failed: ${firstLine(err)}`);
			process.exit(1);
		}
	}

	let result;
	try {
		result = powershell(FIND_OR_CREATE).trim().split(/\r?\n/).pop() ?? '';
	} catch (err) {
		console.error(`[sign] could not reach the certificate store: ${firstLine(err)}`);
		console.error('[sign] set CSC_LINK to a .pfx to sign without a local certificate');
		process.exit(1);
	}

	const [state, thumbprint, subject, expires] = result.split('|');
	if (!thumbprint || !subject) {
		console.error(`[sign] unexpected answer from the certificate store: ${result}`);
		process.exit(1);
	}
	console.log(`[sign] ${state} code-signing certificate ${subject}`);
	console.log(`[sign] thumbprint ${thumbprint}, valid until ${expires}`);
}

/** Forward slashes: PowerShell accepts them and backslashes would need doubling. */
function toPosix(file) {
	return file.replace(/\\/g, '/');
}

function firstLine(err) {
	const text = String(err?.stderr || err?.message || err).trim();
	return text.split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
}

try {
	main();
} catch (err) {
	console.error(`[sign] ${firstLine(err)}`);
	process.exit(1);
}
