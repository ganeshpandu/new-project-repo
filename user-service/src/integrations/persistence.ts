import { Injectable } from '@nestjs/common';
import { PrismaService } from '@traeta/prisma';
import { ACTIVE_CONDITION, REC_SEQ, STATUS } from '../../constants';

@Injectable()
export class IntegrationPersistence {
    constructor(private prisma: PrismaService) { }

    // Ensure Integration by name (e.g., 'strava')
    async ensureIntegration(name: string) {
        const existing = await this.prisma.integrations.findFirst({ where: { name, ...ACTIVE_CONDITION } });
        if (existing) return existing;
        return this.prisma.integrations.create({ data: { name, ...ACTIVE_CONDITION } });
    }

    // Ensure UserIntegrations link
    async ensureUserIntegration(userId: string, integrationId: string) {
        const link = await this.prisma.userIntegrations.findFirst({
            where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, integrationId, integrationRecSeq: REC_SEQ.DEFAULT_RECORD, ...ACTIVE_CONDITION },
        });
        if (link) return link;

        return this.prisma.$transaction(async (tx) => {
            const created = await tx.userIntegrations.create({
                data: {
                    userId,
                    userRecSeq: REC_SEQ.DEFAULT_RECORD,
                    integrationId,
                    integrationRecSeq: REC_SEQ.DEFAULT_RECORD,
                    status: STATUS.PENDING,
                    ...ACTIVE_CONDITION
                },
            });
            await tx.userIntegrationHistory.create({
                data: {
                    userIntegrationId: created.userIntegrationId,
                    userIntegrationRecSeq: REC_SEQ.DEFAULT_RECORD,
                    firstConnectedAt: new Date(),
                    ...ACTIVE_CONDITION
                },
            });
            return created;
        });
    }

    async markConnected(userId: string, integrationId: string) {
        const link = await this.ensureUserIntegration(userId, integrationId);
        await this.prisma.userIntegrations.update({
            where: { userIntegrationId_recSeq: { userIntegrationId: link.userIntegrationId, recSeq: REC_SEQ.DEFAULT_RECORD }, ...ACTIVE_CONDITION },
            data: { status: STATUS.CONNECTED, ...ACTIVE_CONDITION },
        });
        await this.prisma.userIntegrationHistory.updateMany({
            where: {
                userIntegrationId: link.userIntegrationId,
                userIntegrationRecSeq: REC_SEQ.DEFAULT_RECORD,
                ...ACTIVE_CONDITION
            },
            data: { lastConnectedAt: new Date(), ...ACTIVE_CONDITION },
        });
        const integration = await this.prisma.integrations.findUnique({
            where: { integrationId_recSeq:{integrationId:link.integrationId, recSeq:REC_SEQ.DEFAULT_RECORD}, ...ACTIVE_CONDITION },
        });
        if(integration){
            await this.prisma.integrations.update({
                where: { integrationId_recSeq:{integrationId:link.integrationId, recSeq:REC_SEQ.DEFAULT_RECORD}, ...ACTIVE_CONDITION },
                data: {popularity: integration.popularity ? integration.popularity + 1 : 1},
            });
        }
        return link;
    }

    async markSynced(linkId: string, syncedAt?: Date) {
        await this.prisma.userIntegrationHistory.updateMany({
            where: { userIntegrationId: linkId, userIntegrationRecSeq: REC_SEQ.DEFAULT_RECORD, ...ACTIVE_CONDITION },
            data: { lastSyncedAt: syncedAt ?? new Date(), ...ACTIVE_CONDITION },
        });
    }

    async markDisconnected(userId: string, integrationName: string) {
        // First, get the integration by name to get the actual integrationId
        const integration = await this.ensureIntegration(integrationName);

        const link = await this.prisma.userIntegrations.findFirst({
            where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, integrationId: integration.integrationId, integrationRecSeq: REC_SEQ.DEFAULT_RECORD, ...ACTIVE_CONDITION },
        });

        if (link) {
            await this.prisma.userIntegrations.update({
                where: { userIntegrationId_recSeq: { userIntegrationId: link.userIntegrationId, recSeq: REC_SEQ.DEFAULT_RECORD }, ...ACTIVE_CONDITION },
                data: { status: STATUS.DISCONNECTED, ...ACTIVE_CONDITION },
            });
        }

        return link;
    }

    async getLastSyncedAt(userId: string, integrationId: string) {
        const link = await this.prisma.userIntegrations.findFirst({
            where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, integrationId, integrationRecSeq: REC_SEQ.DEFAULT_RECORD, ...ACTIVE_CONDITION },
        });
        if (!link) return null;
        const hist = await this.prisma.userIntegrationHistory.findFirst({
            where: { userIntegrationId: link.userIntegrationId, userIntegrationRecSeq: REC_SEQ.DEFAULT_RECORD, ...ACTIVE_CONDITION },
        });
        return hist?.lastSyncedAt ?? null;
    }

    // Ensure List + UserLists + Category
    async ensureListAndCategoryForUser(userId: string, listName: string, categoryName?: string) {
        let list = await this.prisma.lists.findFirst({ where: { name: listName, ...ACTIVE_CONDITION } });
        if (!list) list = await this.prisma.lists.create({ data: { name: listName, ...ACTIVE_CONDITION } });

        const userList = (await this.prisma.userLists.findFirst({
            where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, listId: list.listId, listRecSeq: REC_SEQ.DEFAULT_RECORD, customName: listName, ...ACTIVE_CONDITION },
        })) ?? (await this.prisma.userLists.create({
            data: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, listId: list.listId, listRecSeq: REC_SEQ.DEFAULT_RECORD, customName: listName, ...ACTIVE_CONDITION },
        }));

        let category: any = null;
        if (categoryName) {
            category = (await this.prisma.itemCategories.findFirst({
                where: { listId: list.listId, listRecSeq: REC_SEQ.DEFAULT_RECORD, name: categoryName, ...ACTIVE_CONDITION },
            })) ?? (await this.prisma.itemCategories.create({
                data: { listId: list.listId, listRecSeq: REC_SEQ.DEFAULT_RECORD, name: categoryName, ...ACTIVE_CONDITION },
            }));
        }
        return { list, userList, category };
    }

    // Create item with attributes; external provider id can be stored inside attributes
    async createListItem(listId: string, listRecSeq: number, userListId: string, userListRecSeq: number, categoryId: string | null, categoryRecSeq: number | null, title: string, attributes: any, attributeDataType: any) {
        return this.prisma.listItems.create({
            data: {
                listId,
                listRecSeq,
                userListId,
                userListRecSeq,
                categoryId: categoryId ?? null,
                categoryRecSeq: REC_SEQ.DEFAULT_RECORD,
                title,
                attributes,
                attributeDataType,
                ...ACTIVE_CONDITION
            },
        });
    }

    // Check if an email already exists by external ID (Gmail message ID)
    async emailExists(listId: string, listRecSeq: number, externalId: string): Promise<boolean> {
        const existing = await this.prisma.listItems.findFirst({
            where: {
                listId,
                listRecSeq,
                attributes: {
                    path: ['external', 'id'],
                    equals: externalId,
                },
                ...ACTIVE_CONDITION,
            },
        });
        return !!existing;
    }

    // Find an existing item by external provider ID
    async findItemByExternalId(listId: string, listRecSeq: number, userListId: string, userListRecSeq: number, title: string, provider: string, externalId: string) {
        return this.prisma.listItems.findFirst({
            where: {
                listId,
                listRecSeq,
                userListId,
                userListRecSeq,
                title,
                attributes: {
                    path: ['external', 'provider'],
                    equals: provider,
                },
                AND: {
                    attributes: {
                        path: ['external', 'id'],
                        equals: externalId,
                    },
                },
                ...ACTIVE_CONDITION,
            },
        });
    }

    // Create or update item with deduplication based on external ID
    async upsertListItem(
        listId: string,
        listRecSeq: number,
        userListId: string,
        userListRecSeq: number,
        categoryId: string | null,
        categoryRecSeq: number | null,
        title: string,
        attributes: any,
        attributeDataType?: any
    ) {
        // Check if item has external ID for deduplication
        if (attributes.external?.provider && attributes.external?.id) {
            const existing = await this.findItemByExternalId(
                listId,
                listRecSeq,
                userListId,
                userListRecSeq,
                title,
                attributes.external.provider,
                attributes.external.id
            );

            if (existing) {
                // Compare attributes to see if update is needed
                const attributesChanged = JSON.stringify(existing.attributes) !== JSON.stringify(attributes);

                if (attributesChanged) {
                    // Update existing item
                    return this.prisma.listItems.update({
                        where: {
                            listItemId_recSeq: {
                                listItemId: existing.listItemId,
                                recSeq: REC_SEQ.DEFAULT_RECORD,
                            },
                        },
                        data: {
                            categoryId: categoryId ?? null,
                            categoryRecSeq: REC_SEQ.DEFAULT_RECORD,
                            attributes,
                            attributeDataType,
                            ...ACTIVE_CONDITION
                        },
                    });
                }

                // No changes, return existing item
                return existing;
            }
        }

        // Create new item if no duplicate found
        return this.createListItem(listId, listRecSeq, userListId, userListRecSeq, categoryId, categoryRecSeq, title, attributes, attributeDataType);
    }
}