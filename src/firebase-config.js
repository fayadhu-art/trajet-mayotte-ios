// Configuration du projet Firebase « trajet-mayotte » (application Web « Trajet Mayotte Web »).
// Ces valeurs sont publiques par nature : la sécurité repose sur firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyA1yInZBFtxvtlfuYnW41v8Kh4unyOsp_4",
  authDomain: "trajet-mayotte.firebaseapp.com",
  projectId: "trajet-mayotte",
  storageBucket: "trajet-mayotte.firebasestorage.app",
  messagingSenderId: "1062860755005",
  appId: "1:1062860755005:web:81dd9585fc613d37f8da54",
};

// Politique de confidentialité publiée avec Firebase Hosting.
export const PRIVACY_URL = "https://trajet-mayotte.web.app/confidentialite.html";

// Adresse du service IA Cloudflare (affichée à la fin de l'installation, voir GUIDE-IA.md).
export const IA_URL = "https://trajet-mayotte-ia.trajetmayotte.workers.dev";
