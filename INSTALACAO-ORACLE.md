# 🚀 Guia de Instalação — Oracle Cloud (Grátis para sempre)

## PARTE 1 — Criar conta Oracle Cloud

1. Acesse: https://www.oracle.com/cloud/free/
2. Clique em "Start for free"
3. Preencha seus dados (precisa de cartão de crédito para verificar, mas NÃO cobra)
4. Escolha região: **Brazil East (São Paulo)** ou **US East (Ashburn)**
5. Aguarde o email de confirmação

---

## PARTE 2 — Criar o servidor (VM)

1. No painel Oracle, vá em **"Compute" → "Instances" → "Create Instance"**
2. Configure:
   - **Name:** whatsapp-disparo
   - **Image:** Ubuntu 22.04 (padrão)
   - **Shape:** VM.Standard.A1.Flex (ARM — GRÁTIS)
     - OCPUs: 2
     - Memory: 12 GB
3. Em **"Add SSH keys"** clique em "Generate a key pair for me" e **BAIXE os dois arquivos** (.key e .pub)
4. Clique em **"Create"**
5. Aguarde ~2 minutos até ficar "Running"
6. Anote o **IP público** da sua VM

---

## PARTE 3 — Conectar no servidor

### Windows (use o PowerShell):
```powershell
ssh -i C:\caminho\para\seu-arquivo.key ubuntu@SEU_IP_AQUI
```

### Mac/Linux:
```bash
chmod 400 seu-arquivo.key
ssh -i seu-arquivo.key ubuntu@SEU_IP_AQUI
```

---

## PARTE 4 — Instalar Node.js no servidor

Cole esses comandos um por um no terminal do servidor:

```bash
# Atualizar o sistema
sudo apt update && sudo apt upgrade -y

# Instalar Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verificar instalação
node --version
npm --version

# Instalar PM2 (mantém o app rodando sempre)
sudo npm install -g pm2

# Instalar Chrome (necessário para WhatsApp)
sudo apt install -y chromium-browser
```

---

## PARTE 5 — Subir o sistema

```bash
# Criar pasta
mkdir ~/whatsapp && cd ~/whatsapp

# Enviar os arquivos (no seu PC local, em outro terminal):
scp -i seu-arquivo.key -r /caminho/para/whatsapp-multi/* ubuntu@SEU_IP:~/whatsapp/

# De volta no servidor — instalar dependências
cd ~/whatsapp
npm install

# Testar se funciona
npm start
# (Ctrl+C para parar depois de testar)
```

---

## PARTE 6 — Rodar sempre (PM2)

```bash
# Iniciar com PM2
pm2 start server.js --name whatsapp-disparo

# Configurar para iniciar automaticamente ao reiniciar o servidor
pm2 startup
pm2 save

# Ver status
pm2 status

# Ver logs
pm2 logs whatsapp-disparo
```

---

## PARTE 7 — Liberar porta no Oracle (IMPORTANTE)

Por padrão o Oracle bloqueia portas externas. Você precisa liberar a porta 3000:

1. No painel Oracle, vá em **"Networking" → "Virtual Cloud Networks"**
2. Clique na sua VCN → **"Security Lists"** → **"Default Security List"**
3. Clique em **"Add Ingress Rules"**:
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: TCP
   - Destination Port: `3000`
4. Salve

Também libere no Ubuntu:
```bash
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save
```

---

## PARTE 8 — Acessar o sistema

Abra no navegador:
```
http://SEU_IP:3000
```

Login padrão:
- **Usuário:** admin
- **Senha:** admin123

⚠️ **IMPORTANTE:** Troque a senha do admin imediatamente após o primeiro login!

---

## 🔐 Dica de Segurança — Usar domínio próprio com HTTPS

Se quiser um endereço bonito tipo `seusite.com.br` com HTTPS:
1. Compre um domínio (Registro.br, ~R$40/ano)
2. Aponte o DNS para o IP do Oracle
3. Instale Nginx + Certbot (SSL grátis)

Quer esse guia também? É só pedir!
