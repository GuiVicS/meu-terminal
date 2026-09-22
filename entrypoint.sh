#!/bin/bash

# Function to remove and Starship
remove_customizations() {   
    # Remove Starship binary if it exists
    if [ -f "/usr/local/bin/starship" ]; then
        echo "Removing Starship..."
        rm /usr/local/bin/starship
    fi
    
    # # Remove Starship config
    # if [ -f "/root/.config/starship.toml" ]; then
    #     rm /root/.config/starship.toml
    # fi
    # if [ -d "/root/.config/starship" ]; then
    #     rm -rf /root/.config/starship
    # fi
}

# Always remove any existing Starship initialization first
sed -i '/eval "$(starship init bash)"/d' /root/.bashrc

# Handle Starship and Nerd Fonts based on ENABLE_STARSHIP env var
if [ "$ENABLE_STARSHIP" = "true" ]; then
    # Create config directory and copy starship config if it exists
    mkdir -p /root/.config
    if [ -f "/app/config/starship.toml" ]; then
        cp /app/config/starship.toml /root/.config/starship.toml
    fi

    # Initialize Starship in .bashrc
    echo 'eval "$(starship init bash)"' >> /root/.bashrc
    echo "Starship initialization completed!"
else
    remove_customizations
    echo "Starship and customizations have been disabled and removed"
fi

# Execute the passed command from the app directory
cd /app
exec "$@"