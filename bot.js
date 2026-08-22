require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes } = require('discord.js');

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// Helper to generate Room ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

client.on('ready', async () => {
    console.log(`Bot logged in as ${client.user.tag}`);

    // Cria o comando /tela
    const commands = [{
        name: 'tela',
        description: 'Gera links mágicos para compartilhar a tela com seus amigos!'
    }];

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
        // Registra o comando instantaneamente nos servidores em que o bot está
        client.guilds.cache.forEach(async (guild) => {
            await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
        });
        console.log('Slash commands registrados.');
    } catch (error) {
        console.error('Erro ao registrar commands:', error);
    }
});

// Somente Slash Commands habilitados (/tela)

// Quando o comando /tela for usado
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'tela') {
        await handleTelaCommand(interaction);
    }
});

async function handleTelaCommand(context) {
    const roomId = generateRoomId();
    const baseUrl = process.env.BASE_URL;

    if (!baseUrl || baseUrl.includes('COLOQUE_SEU_LINK')) {
        const errMsg = "❌ A BASE_URL não está configurada no .env!";
        if (context.reply) await context.reply(errMsg);
        else await context.channel.send(errMsg);
        return;
    }

    const hostLink = `${baseUrl}/?room=${roomId}&role=host`;
    const viewerLink = `${baseUrl}/?room=${roomId}&role=viewer`;

    // Cria os botões que aparecerão no chat do Discord
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setLabel('🎬 Começar Transmissão (Você)')
                .setStyle(ButtonStyle.Link)
                .setURL(hostLink),
            new ButtonBuilder()
                .setLabel('👀 Assistir (Seus Amigos)')
                .setStyle(ButtonStyle.Link)
                .setURL(viewerLink)
        );

    const replyContent = {
        content: `**📺 Sala de Compartilhamento de Tela Privada**\n\nCódigo de Acesso: \`${roomId}\`\nEscolha o que você vai fazer:`,
        components: [row]
    };

    if (context.reply) {
        await context.reply(replyContent);
    } else {
        await context.channel.send(replyContent);
    }
}

client.login(process.env.BOT_TOKEN);
