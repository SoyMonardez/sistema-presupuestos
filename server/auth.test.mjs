// node server/auth.test.mjs — lectura de accesos y tokens por espacio.
process.env.APP_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'clave-principal';
process.env.APP_PASSWORD_OTRO = 'clave-otro';

const { loadAccesses, verifyPassword, issueToken, verifyToken } = await import('./auth.js');

let fallos = 0;
function ok(nombre, cond) {
    console.log(`${cond ? 'OK  ' : 'FALLA'} ${nombre}`);
    if (!cond) fallos++;
}

ok('cada contraseña abre su espacio', verifyPassword('clave-principal') === 'principal' && verifyPassword('clave-otro') === 'otro');
ok('una contraseña mala no abre nada', verifyPassword('mala') === null && verifyPassword('') === null);
ok('el token lleva su espacio', verifyToken(issueToken('otro')) === 'otro');
ok('un token adulterado no sirve', verifyToken(issueToken('otro').replace(/.$/, c => (c === 'a' ? 'b' : 'a'))) === null);
ok('un espacio que ya no está en el .env no sirve', verifyToken(issueToken('borrado')) === null);

const s = Buffer.from(JSON.stringify({ exp: Date.now() + 1e6 })).toString('base64url');
const { createHmac } = await import('node:crypto');
const viejo = `${s}.${createHmac('sha256', 'test-secret').update(s).digest('base64url')}`;
ok('un token de antes (sin espacio) es del principal', verifyToken(viejo) === 'principal');

let repetida = false;
try { loadAccesses({ APP_PASSWORD: 'x', APP_PASSWORD_A: 'x' }); } catch { repetida = true; }
ok('dos accesos con la misma contraseña se rechazan', repetida);

let reservado = false;
try { loadAccesses({ APP_PASSWORD: 'x', APP_PASSWORD_PRINCIPAL: 'y' }); } catch { reservado = true; }
ok('"principal" no se puede usar como nombre extra', reservado);

process.exit(fallos ? 1 : 0);
