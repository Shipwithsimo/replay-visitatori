# Server gratuito su Oracle Cloud

Circa 15 minuti, una volta sola.

## 1. Crea il server

1. Registrati su [oracle.com/cloud/free](https://www.oracle.com/cloud/free/). Ti chiedono una carta solo per verifica: con le risorse "Always Free" non paghi nulla.
2. Nel pannello: **Compute → Instances → Create instance**.
   - **Image**: Canonical Ubuntu 24.04.
   - **Shape**: *Change shape → Ampere → VM.Standard.A1.Flex*, 1 OCPU e 6 GB di RAM bastano. Se non è disponibile scegli *VM.Standard.E2.1.Micro*, anche quella è gratuita.
   - **Add SSH keys**: *Generate a key pair for me* e scarica la chiave privata.
   - Clicca **Create**.
3. Apri le porte web: nella pagina dell'istanza clicca la **Subnet** → **Security Lists** → **Default Security List** → **Add Ingress Rules**:
   - Source CIDR `0.0.0.0/0`, Destination port `80,443`.

## 2. Installa l'app

1. Nella pagina dell'istanza clicca **Launch Cloud Shell** (o collegati in SSH con la chiave scaricata: `ssh -i chiave.key ubuntu@IP`).
2. Crea un [token GitHub](https://github.com/settings/personal-access-tokens/new) di sola lettura per il repository `replay-visitatori` (*Repository access → Only select repositories*, *Contents: Read-only*).
3. Sul server:
   ```bash
   nano setup.sh      # incolla il contenuto di deploy/oracle-setup.sh, poi Ctrl+O, Invio, Ctrl+X
   bash setup.sh
   ```
   Lo script chiede il token, una password per il pannello e il dominio `.myshopify.com` del negozio, poi installa tutto.
4. Alla fine stampa l'indirizzo del server, tipo `https://152-70-1-2.sslip.io`. Aprilo, entra con la password e manda l'indirizzo a Claude.
